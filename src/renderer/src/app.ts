import './styles.css'
import type { AppState, ErrorReason, KNode, LoadResult, Mastery, Question, SubmitResult, Task } from '../../shared/types'
import { band, effective, freshMastery, masteryScore } from '../../shared/mastery'
import { KnowledgeGraph, type GraphMode } from './graph'
import { createLocalApi } from './local-api'
import {
  applyDiagAnswer,
  createDiagnostic,
  nextQuestion,
  primaryNodeOf,
  summarize,
  type DiagState,
  type DiagSummary
} from '../../main/domain/diagnostic'
import { BANDS, buildHeatmap, summarizeHeat } from '../../main/domain/heatmap'
import { REASONS, attributionLine } from '../../main/domain/attribution'
import aiJson from '../../../resources/ai/gaokao-math-function.json'
import { addCard, isSaved, loadCards, removeCard } from './cards'
import { askAi, endpointStatus, generatePack, generateQuestions, getEndpoint, initEndpoint, setEndpoint, type AiAnswer } from './ai'
import { addToBank } from './qbank'
import { addUserNode, clearPositions, loadPositions, removeUserNode, saveOnePosition } from './edits'
import { currentPack, listPacks, packProgress, questionsOfPack, relTime, removeCustomPack, renamePack, resolvePack, saveCustomPack, saveMergedPack, setActivePackId, markStudied, stateOfPack } from './packs'
import { canMerge, mergeSources } from '../../main/domain/merge'
import { normalizeGeneratedPack } from '../../main/domain/pack'

/** 实时提问的状态（只保留当前节点的） */
let askState: { nodeId: string; loading: boolean; answer?: AiAnswer; error?: string } | null = null

/** 正在为哪个考点准备题目（避免重复请求） */
const preparing = new Set<string>()

function questionsOf(nodeId: string): Question[] {
  return questions.filter((q) => q.tags?.some((t) => t.nodeId === nodeId))
}

/**
 * 按需出题：只有当用户真的要做的这个考点题不够时，才现出 3 道。
 * 返回是否可用（已有题 或 生成成功）。
 */
async function ensureQuestions(nodeId: string, need = 3): Promise<boolean> {
  if (questionsOf(nodeId).length >= need) return true
  const ai = endpointStatus()
  if (!ai.reachable || !ai.supportsQuestions) return false
  if (preparing.has(nodeId)) return false
  preparing.add(nodeId)
  try {
    const node = nodeById(nodeId)
    if (!node) return false
    const want = need - questionsOf(nodeId).length
    const got = await generateQuestions(node, want, [2, 3, 4].slice(0, want), {
      exam: pack.meta?.exam ?? '',
      subject: pack.meta?.subject ?? pack.subject ?? '',
      // 融合板块里，出题上下文用它原本所属的章节，避免串到别的章
      chapter: node.origin ?? pack.meta?.chapter ?? pack.title ?? ''
    })
    if (!got.length) return false
    const saved = addToBank(pack.packId, got, nodeId)
    questions.push(...saved)
    return questionsOf(nodeId).length >= 1
  } catch {
    return false
  } finally {
    preparing.delete(nodeId)
  }
}

interface AiNodeContent {
  explain: string
  cards: { type: string; front: string; back: string }[]
}
const AI_CONTENT = aiJson as unknown as {
  promptVersion: string
  model: string
  byNode: Record<string, AiNodeContent>
}
import {
  GUIDE_RELEASES,
  GUIDE_RULES,
  GUIDE_STEPS,
  GUIDE_VERSION,
  markSeen,
  shouldShowGuide
} from './guide'

interface Overview {
  coverage: { measured: number; total: number }
  estimate: number
  band: number
  daysLeft: number
  todayKey: string
}

interface Api {
  load(): Promise<LoadResult & { overview: Overview }>
  submit(p: {
    questionId: string
    answer: string
    durationMs: number
    selfConfidence: 'sure' | 'unsure'
    errorReason: ErrorReason
  }): Promise<SubmitResult & { today: Task[]; overview: Overview }>
  check(questionId: string, answer: string): Promise<{ correct: boolean }>
  updateSettings(patch: Partial<AppState['settings']>): Promise<{ state: AppState; today: Task[]; overview: Overview }>
  completeTask(id: string): Promise<{ state: AppState; today: Task[]; overview: Overview }>
  postponeTask(id: string): Promise<{ state: AppState; today: Task[]; overview: Overview }>
  rebuildQueue(): Promise<{ today: Task[]; overview: Overview }>
  rate(nodeId: string, level: 0 | 1 | 2): Promise<{ state: AppState; today: Task[]; overview: Overview }>
}

/** 有 Electron 预加载就用它；在浏览器里跑时退回本地实现（同一套算法，数据存 localStorage） */
const api: Api = (window as unknown as { api?: Api }).api ?? createLocalApi()

const BAND_COLOR: Record<string, string> = {
  red: 'var(--c1)',
  orange: 'var(--c2)',
  yellow: 'var(--c3)',
  green: 'var(--c5)',
  unmeasured: 'var(--c0)'
}

const KIND_LABEL: Record<string, string> = { review: '到期复习', gap: '缺口补救', new: '新学' }
const BAND_NAME: Record<string, string> = {
  red: '红',
  orange: '橙',
  yellow: '黄',
  green: '绿',
  unmeasured: '未测'
}

let pack: LoadResult['pack']
let questions: Question[] = []
let state: AppState
let today: Task[] = []
let overview: Overview
let selectedId: string | null = null
let graph: KnowledgeGraph
let mode: GraphMode = 'structure'

const $ = <T extends Element = HTMLElement>(sel: string): T => document.querySelector(sel) as T

/** 转义：题干和讲解里全是 0<a<1 这种数学符号，不转义会被当成 HTML 标签吞掉 */
const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  )

function nodeById(id: string): KNode | undefined {
  return pack.nodes.find((n) => n.id === id)
}

function pathOf(id: string): string {
  const names: string[] = []
  let cur = nodeById(id)
  while (cur) {
    names.unshift(cur.name)
    cur = cur.parentId ? nodeById(cur.parentId) : undefined
  }
  return names.join(' › ')
}

function masteryOf(id: string): Mastery {
  return state.mastery[id] ?? { K: 0, A: 0.3, s: 1, n: 0, nok: 0, misconception: 0, lastAt: null }
}

/** 一条前置关系的"为什么" */
function whyOf(a: string, b: string, kind: 'prereq' | 'confusable'): string {
  const r = (pack.relations ?? []).find(
    (x) => x.kind === kind && ((x.a === a && x.b === b) || (x.a === b && x.b === a))
  )
  return r?.why ?? ''
}

/** 该考点往上所有前置，按"先学的在前"排好 */
function foundationChain(id: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (cur: string): void => {
    const n = nodeById(cur)
    if (!n) return
    for (const p of n.prereq) {
      if (seen.has(p)) continue
      seen.add(p)
      walk(p)
      out.push(p)
    }
  }
  walk(id)
  return out
}

/* ---------------- 使用指南 ---------------- */

function closeGuide(): void {
  const box = $('#guide')
  markSeen()
  box.classList.remove('open')
  box.innerHTML = ''
}

function renderGuide(): void {
  const box = $('#guide')
  const latest = GUIDE_RELEASES[0]
  const history = GUIDE_RELEASES.slice(1).map((r) => `v${r.version}`).join(' · ')

  box.innerHTML = `
    <div class="gsheet">
      <div class="ghead">
        <div>
          <h2>使用指南</h2>
          <div class="gsub">v${GUIDE_VERSION} · 每次更新都会重写这一页</div>
        </div>
        <button class="ghost small" id="gclose">关闭</button>
      </div>

      <ol class="gsteps">
        ${GUIDE_STEPS.map(
          (s, i) =>
            `<li><div class="gtitle"><span class="gnum">${i + 1}</span>${s.title}</div><p>${s.body}</p></li>`
        ).join('')}
      </ol>

      <div class="gblock">
        <h3>几条规矩（都是故意的）</h3>
        <ul class="grules">${GUIDE_RULES.map((r) => `<li>${r}</li>`).join('')}</ul>
      </div>

      <div class="gblock">
        <h3>本次更新 · v${latest.version}</h3>
        <ul class="grules">${latest.items.map((r) => `<li>${r}</li>`).join('')}</ul>
        ${history ? `<div class="gsub" style="margin-top:10px">更早的版本：${history}</div>` : ''}
      </div>

      <div class="gfoot"><button class="primary" id="gok">开始使用</button></div>
    </div>
  `
  box.classList.add('open')
  box.onclick = (e) => {
    if (e.target === box) closeGuide()
  }
  box.querySelector('#gclose')?.addEventListener('click', () => closeGuide())
  box.querySelector('#gok')?.addEventListener('click', () => closeGuide())
}

/* ---------------- 设置 ---------------- */

function renderSettings(): void {
  const box = $('#settings')
  const s = state.settings
  let minutes = s.dailyMinutes

  box.innerHTML = `
    <div class="gsheet" style="width:min(520px,92vw)">
      <div class="ghead">
        <div>
          <h2>设置</h2>
          <div class="gsub">改完立即生效，今天的任务会重排</div>
        </div>
        <button class="ghost small" id="set-close">关闭</button>
      </div>

      <div class="sblock">
        <h3>考试日期</h3>
        <input type="date" id="set-date" value="${s.examDate}" class="sinput" />
        <div class="gsub" style="margin-top:6px">顶栏的倒计时按它算；考前 30 天自动切到抢分模式</div>
      </div>

      <div class="sblock">
        <h3>每天最多花多久</h3>
        <div class="rchips">
          ${[20, 40, 60, 90].map((m) => `<button class="rc ${m === minutes ? 'sel' : ''}" data-min="${m}">${m} 分钟</button>`).join('')}
        </div>
        <div class="gsub" style="margin-top:6px">超出的任务不会排给你——宁可少给，也不让你想卸载</div>
      </div>

      <div class="sblock">
        <h3>AI 服务地址（可选）</h3>
        <input type="text" id="set-ai" value="${esc(getEndpoint())}" placeholder="http://127.0.0.1:3300" class="sinput" style="width:100%" />
        <div class="gsub" style="margin-top:6px">
          留空 = 只用预生成讲解（离线可用）。想用实时问答：先在命令行跑
          <code>node scripts/ai-proxy.cjs</code>，再把地址填这里。浏览器版必须这样走，因为直接调 API 会被跨域拦住。
        </div>
      </div>

      <div class="sblock">
        <h3>科目满分</h3>
        <input type="number" id="set-score" value="${s.totalScore}" min="10" max="300" class="sinput" style="width:120px" />
      </div>

      <div class="gfoot" style="justify-content:space-between">
        <button class="ghost small" id="set-rebuild">重排今日任务</button>
        <button class="primary" id="set-save">保存</button>
      </div>
    </div>
  `
  box.classList.add('open')
  box.onclick = (e) => {
    if (e.target === box) closeSettings()
  }

  box.querySelectorAll<HTMLButtonElement>('[data-min]').forEach((b) => {
    b.addEventListener('click', () => {
      minutes = Number(b.dataset.min)
      box.querySelectorAll<HTMLButtonElement>('[data-min]').forEach((x) => x.classList.toggle('sel', x === b))
    })
  })

  box.querySelector('#set-close')?.addEventListener('click', () => closeSettings())
  box.querySelector('#set-rebuild')?.addEventListener('click', async () => {
    const r = await api.rebuildQueue()
    today = r.today
    overview = r.overview
    closeSettings()
    renderToday()
    renderHeader()
  })
  box.querySelector('#set-save')?.addEventListener('click', async () => {
    const date = box.querySelector<HTMLInputElement>('#set-date')?.value ?? s.examDate
    const score = Number(box.querySelector<HTMLInputElement>('#set-score')?.value ?? s.totalScore)
    const ai = box.querySelector<HTMLInputElement>('#set-ai')?.value ?? ''
    setEndpoint(ai)
    const r = await api.updateSettings({ examDate: date, dailyMinutes: minutes, totalScore: score })
    state = r.state
    today = r.today
    overview = r.overview
    closeSettings()
    renderHeader()
    renderToday()
    refreshVisuals()
  })
}

function closeSettings(): void {
  const box = $('#settings')
  box.classList.remove('open')
  box.innerHTML = ''
}

/* ---------------- 进入向导：先问清楚你在学什么 ---------------- */

interface WizardState {
  exam: string
  subject: string
  chapter: string
  customChapter: string
  busy: boolean
  error?: string
}

let wizard: WizardState | null = null

const EXAMS = ['高考', '中考', '考研', '其他']
const SUBJECTS = ['数学', '物理', '化学', '英语']

function renderWizard(): void {
  const box = $('#wizard')
  if (!wizard) wizard = { exam: '', subject: '数学', chapter: '', customChapter: '', busy: false }
  const w = wizard
  const packs = listPacks()
  const ai = endpointStatus()
  const hasProxy = ai.reachable && ai.supportsPack
  const step = !w.exam ? 1 : !w.chapter && !w.customChapter ? 2 : 3

  box.innerHTML = `
    <div class="gsheet" style="width:min(620px,92vw)">
      <div class="ghead">
        <div>
          <h2>先告诉我你在学什么</h2>
          <div class="gsub">选完直接进入，之后能随时在顶栏「章节」里换</div>
        </div>
        <button class="ghost small" id="wz-close" title="关闭（Esc）">✕</button>
      </div>

      <div class="wstep ${step === 1 ? 'cur' : ''}">
        <div class="wlabel">1 · 在准备什么考试</div>
        <div class="rchips">
          ${EXAMS.map((e) => `<button class="rc ${w.exam === e ? 'sel' : ''}" data-exam="${e}">${e}</button>`).join('')}
        </div>
      </div>

      ${
        w.exam
          ? `<div class="wstep ${step === 2 ? 'cur' : ''}">
              <div class="wlabel">2 · 哪一科</div>
              <div class="rchips">
                ${SUBJECTS.map((s) => `<button class="rc ${w.subject === s ? 'sel' : ''}" data-subject="${s}">${s}</button>`).join('')}
              </div>
            </div>`
          : ''
      }

      ${
        step >= 2
          ? `<div class="wstep ${step === 3 ? 'cur' : ''}">
              <div class="wlabel">3 · 现在学哪一章</div>
              ${packs
                .map(
                  (p) =>
                    `<div class="packrow ${w.chapter === p.id ? 'sel' : ''}" data-pack="${p.id}">
                       <span>${esc(p.title)}</span>
                       <span class="tagx">${p.builtin ? '内置 · 有题库' : 'AI 生成'}</span>
                     </div>`
                )
                .join('')}
              <div class="askrow" style="margin-top:10px">
                <input id="wz-chapter" placeholder="没有？直接写章节名，比如「立体几何」" value="${esc(w.customChapter)}" />
                <button class="small" id="wz-gen" ${w.busy ? 'disabled' : ''}>${w.busy ? '生成中…' : 'AI 生成'}</button>
              </div>
              ${
                hasProxy
                  ? `<div class="hint" style="margin-top:6px">AI 会现场拆出一张 20 个左右考点的知识地图（约 6 秒）。新章节暂时没有题库，先用自评打标。</div>`
                  : !ai.endpoint
                    ? `<div class="hint" style="margin-top:6px;color:#9a4b0a">没检测到 AI 服务。想生成新章节：先跑 <code>node scripts/ai-proxy.cjs</code>，再刷新本页。</div>`
                    : !ai.reachable
                      ? `<div class="hint" style="margin-top:6px;color:#9a4b0a">连不上 ${esc(ai.endpoint)}。确认 <code>node scripts/ai-proxy.cjs</code> 正在运行，或去「设置 → AI 服务地址」改掉。</div>`
                      : `<div class="hint" style="margin-top:6px;color:#9a4b0a">代理在跑，但它没有生成接口（旧版本）。关掉那个窗口，重新 <code>node scripts/ai-proxy.cjs</code>。</div>`
              }
            </div>`
          : ''
      }

      ${w.error ? `<div class="hint" style="color:#a52222;margin-top:12px">${esc(w.error)}</div>` : ''}
    </div>
  `
  box.classList.add('open')
  box.onclick = (e) => {
    if (e.target === box) closeWizard()
  }
  box.querySelector('#wz-close')?.addEventListener('click', () => closeWizard())

  box.querySelectorAll<HTMLButtonElement>('[data-exam]').forEach((b) => {
    b.addEventListener('click', () => {
      wizard!.exam = b.dataset.exam as string
      wizard!.chapter = ''
      renderWizard()
    })
  })
  box.querySelectorAll<HTMLButtonElement>('[data-subject]').forEach((b) => {
    b.addEventListener('click', () => {
      wizard!.subject = b.dataset.subject as string
      renderWizard()
    })
  })
  box.querySelectorAll<HTMLElement>('[data-pack]').forEach((el) => {
    el.addEventListener('click', () => enterPack(el.dataset.pack as string))
  })
  const input = box.querySelector<HTMLInputElement>('#wz-chapter')
  if (input && w.customChapter) input.value = w.customChapter
  input?.addEventListener('input', () => {
    wizard!.customChapter = input.value
  })
  box.querySelector('#wz-gen')?.addEventListener('click', () => void generateCustomChapter())
}

async function generateCustomChapter(): Promise<void> {
  const w = wizard
  if (!w) return
  const chapter = w.customChapter.trim()
  if (!chapter) {
    w.error = '先写一个章节名'
    renderWizard()
    return
  }
  if (!getEndpoint()) {
    w.error = '没有可用的 AI 服务：先在命令行跑 node scripts/ai-proxy.cjs'
    renderWizard()
    return
  }
  if (!endpointStatus().supportsPack) {
    w.error = '代理在跑但没有生成接口（旧版本），请关掉重开 node scripts/ai-proxy.cjs'
    renderWizard()
    return
  }
  w.busy = true
  w.error = undefined
  renderWizard()
  try {
    const raw = await generatePack({ exam: w.exam, subject: w.subject, chapter })
    if (!raw) throw new Error('AI 服务未连接')
    const pack = normalizeGeneratedPack(raw)
    saveCustomPack(pack)

    // 顺便只备"摸底够用"的一小撮题：权重最高的 3 个考点 × 3 道
    // （不预生成整本题库——用户不会一看到图就要做所有题）
    const seeded = [...pack.nodes]
      .filter((n) => n.kind !== 'root')
      .sort((a, b) => b.examWeight - a.examWeight)
      .slice(0, 3)
    if (endpointStatus().supportsQuestions) {
      for (let i = 0; i < seeded.length; i++) {
        w.error = undefined
        const node = seeded[i]
        renderWizardProgress(`正在备摸底题 ${i + 1}/${seeded.length}：${node.name}`)
        try {
          const got = await generateQuestions(node, 3, [2, 3, 4], {
            exam: w.exam,
            subject: w.subject,
            chapter
          })
          if (got.length) addToBank(pack.packId, got, node.id)
        } catch {
          /* 单个考点失败不影响整体，剩下等用户要做时现出 */
        }
      }
    }

    enterPack(pack.packId)
  } catch (e) {
    w.busy = false
    w.error = `生成失败：${(e as Error).message}（请求地址 ${getEndpoint()}）`
    renderWizard()
  }
}

/** 向导里的进度提示（不重绘整个向导，避免输入框被清空） */
function renderWizardProgress(text: string): void {
  const box = $('#wizard .gsheet')
  if (!box) return
  let el = box.querySelector<HTMLElement>('.wz-progress')
  if (!el) {
    el = document.createElement('div')
    el.className = 'wz-progress'
    box.append(el)
  }
  el.textContent = text
}

/** 关掉向导（不选也不能把人锁死在里面） */
function closeWizard(): void {
  const box = $('#wizard')
  box.classList.remove('open')
  box.innerHTML = ''
  box.onclick = null
  wizard = null
}

/**
 * Esc 关掉最上层浮层。
 * 之前向导没有关闭入口，用户卡在里面只能刷新页面——这就是这个函数存在的理由。
 */
function closeTopOverlay(): boolean {
  const layers: [string, () => void][] = [
    ['#wizard', closeWizard],
    ['#cards', closeCards],
    ['#settings', closeSettings],
    ['#guide', closeGuide],
    ['#modal', closeModal]
  ]
  for (const [sel, close] of layers) {
    const el = $(sel)
    if (el && el.classList.contains('open')) {
      close()
      return true
    }
  }
  return false
}

function closeModal(): void {
  const box = $('#modal')
  box.classList.remove('open')
  box.innerHTML = ''
  session = null
}

/* ---------------- 大厅 ---------------- */

/** 大厅里的多选（用于融合板块），只存在内存里 */
let picked = new Set<string>()

function renderHome(): void {
  const box = $('#home')
  const packs = listPacks()
  const cards = loadCards()
  const recent = cards.sort((a, b) => b.at - a.at).slice(0, 3)
  // 已删除/已融合掉的板块要从选中集合里踢出去
  picked = new Set([...picked].filter((id) => packs.some((p) => p.id === id)))

  const mergeCheck = (() => {
    if (picked.size < 2) return { ok: false, reason: '勾选 2 个同学科的板块，就能把它们融合成一个' }
    const chosen = [...picked].map((id) => resolvePack(id)).filter((p): p is NonNullable<typeof p> => !!p)
    return canMerge(chosen)
  })()

  const packCards = packs
    .map((entry) => {
      const pack = resolvePack(entry.id)
      if (!pack) return ''
      const prog = packProgress(entry.id)
      const pct = prog.total ? Math.round((prog.measured / prog.total) * 100) : 0
      const on = picked.has(entry.id)
      const merged = entry.id.startsWith('merge-')
      return `<div class="pcard ${on ? 'picked' : ''}" data-pack-card="${entry.id}">
        <div class="pmeta">
          ${esc(entry.exam)} · ${esc(entry.subject)}
          <button class="pick ${on ? 'on' : ''}" data-pick="${entry.id}" title="${on ? '取消选择' : '选中（用于融合）'}">${on ? '✓' : '＋'}</button>
        </div>
        <div class="ptitle">${esc(entry.chapter)}</div>
        <div class="pbar"><i style="width:${pct}%"></i></div>
        <div class="pstat">
          已测 ${prog.measured}/${prog.total} · ${relTime(prog.lastAt)}
          ${entry.builtin ? '' : merged ? ' · 融合板块' : ' · AI 生成'}
        </div>
        <div class="pactions">
          <button class="primary small" data-enter="${entry.id}">继续学习</button>
          <button class="ghost small" data-rename="${entry.id}">改名</button>
          ${entry.builtin ? '' : `<button class="ghost small" data-drop="${entry.id}">删除</button>`}
        </div>
      </div>`
    })
    .join('')

  box.innerHTML = `
    <div class="hhead">
      <div class="brand">GapGraph<span>缺口图谱</span></div>
      <div class="spacer"></div>
      <button class="ghost small" id="h-cards">知识库 ${cards.length}</button>
      <button class="ghost small" id="h-settings">设置</button>
      <button class="ghost small" id="h-guide">指南</button>
    </div>

    <div class="hmain">
      <div class="hero" id="h-new">
        <div>
          <div class="hero-k">开始学习新板块</div>
          <div class="hero-t">选一个考试和章节，或者写个章节名，让 AI 现场拆出一张知识地图</div>
        </div>
        <button class="primary" id="h-add">+ 添加板块</button>
      </div>

      ${
        picked.size
          ? `<div class="mergebox">
               <div class="mergeinfo">
                 <b>已选 ${picked.size} 个板块</b>
                 <span class="${mergeCheck.ok ? 'okline' : 'badline'}">${
                   mergeCheck.ok ? '同学科，可以融合成一张图' : esc(mergeCheck.reason ?? '')
                 }</span>
               </div>
               <div class="askrow" style="margin-top:10px">
                 <input id="merge-name" placeholder="给融合后的板块取个名字，比如「烃类化合物」" />
                 <button class="primary small" id="merge-go" ${mergeCheck.ok ? '' : 'disabled'}>融合</button>
                 <button class="ghost small" id="merge-cancel">取消</button>
               </div>
             </div>`
          : ''
      }

      ${
        packs.length
          ? `<h3 class="sec">我的板块</h3><div class="packgrid">${packCards}</div>`
          : `<h3 class="sec">我的板块</h3><div class="emptybox">还没有板块。点上面的「添加板块」开始。</div>`
      }

      <h3 class="sec">知识库</h3>
      ${
        cards.length
          ? `<div class="kbbox">
               <div class="kbhead">
                 <span>已收藏 ${cards.length} 张卡片</span>
                 <button class="ghost small" id="h-kb">打开知识库</button>
               </div>
               ${recent
                 .map(
                   (c) => `<div class="kbrow">
                     <span class="actype ${c.type}">卡片</span>
                     <span class="kbfront">${esc(c.front)}</span>
                     <span class="acfrom">${esc(c.nodeName)}</span>
                   </div>`
                 )
                 .join('')}
             </div>`
          : `<div class="emptybox">还没有收藏。学习时点开任意考点，讲解下面的卡片点 ☆ 就能存到这里。</div>`
      }
    </div>
  `

  $('#h-add')?.addEventListener('click', () => renderWizard())
  $('#h-cards')?.addEventListener('click', () => renderCards())
  $('#h-kb')?.addEventListener('click', () => renderCards())
  $('#h-guide')?.addEventListener('click', () => renderGuide())
  $('#h-settings')?.addEventListener('click', () => renderSettings())
  box.querySelectorAll<HTMLButtonElement>('[data-enter]').forEach((b) => {
    b.addEventListener('click', () => enterPack(b.dataset.enter as string))
  })
  box.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      const id = b.dataset.pick as string
      if (picked.has(id)) picked.delete(id)
      else picked.add(id)
      renderHome()
    })
  })
  box.querySelectorAll<HTMLButtonElement>('[data-rename]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      openRename(b.dataset.rename as string)
    })
  })
  box.querySelectorAll<HTMLButtonElement>('[data-drop]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      const id = b.dataset.drop as string
      if (confirm('删除这个板块？学习记录会一起删除。')) {
        removeCustomPack(id)
        renderHome()
      }
    })
  })
  box.querySelector('#merge-cancel')?.addEventListener('click', () => {
    picked.clear()
    renderHome()
  })
  box.querySelector('#merge-go')?.addEventListener('click', () => void doMerge())
}

/* ---------------- 融合板块 ---------------- */

async function doMerge(): Promise<void> {
  const ids = [...picked]
  const sources = ids
    .map((id) => resolvePack(id))
    .filter((p): p is NonNullable<typeof p> => !!p)
  const gate = canMerge(sources)
  if (!gate.ok) {
    alert(gate.reason ?? '不能融合')
    return
  }
  const input = $('#merge-name') as HTMLInputElement | null
  const title = (input?.value ?? '').trim()
  if (!title) {
    alert('先给融合后的板块取个名字')
    input?.focus()
    return
  }
  const btn = $('#merge-go') as HTMLButtonElement | null
  if (btn) {
    btn.disabled = true
    btn.textContent = '融合中…'
  }
  try {
    const merged = mergeSources(
      sources.map((p) => {
        const st = stateOfPack(p)
        return { pack: p, questions: questionsOfPack(p.packId), mastery: st.mastery, attempts: st.attempts }
      }),
      title
    )
    const state: AppState = {
      settings: {
        dailyMinutes: 40,
        examDate: '2027-06-07',
        totalScore: merged.pack.totalScore,
        packId: merged.pack.packId
      },
      mastery: merged.mastery,
      attempts: merged.attempts,
      tasks: []
    }
    saveMergedPack(merged.pack, merged.questions, state)
    picked.clear()
    if (merged.warnings.length) alert(merged.warnings.join('\n'))
    enterPack(merged.pack.packId)
  } catch (e) {
    alert(`融合失败：${(e as Error).message}`)
    renderHome()
  }
}

/* ---------------- 重命名板块 ---------------- */

function openRename(packId: string): void {
  const entry = listPacks().find((p) => p.id === packId)
  if (!entry) return
  const box = $('#cards')
  box.innerHTML = `
    <div class="gsheet" style="width:min(460px,92vw)">
      <div class="ghead">
        <div>
          <h2>给板块改名</h2>
          <div class="gsub">只改显示名，考点、题目、记录都不动</div>
        </div>
        <button class="ghost small" id="rn-close">✕</button>
      </div>
      <div class="sblock">
        <input id="rn-input" class="sinput" style="width:100%" maxlength="40" value="${esc(entry.chapter)}" />
      </div>
      <div class="gfoot" style="justify-content:flex-end;gap:8px">
        <button class="ghost small" id="rn-cancel">取消</button>
        <button class="primary" id="rn-save">保存</button>
      </div>
    </div>
  `
  box.classList.add('open')
  const input = box.querySelector<HTMLInputElement>('#rn-input')
  input?.focus()
  input?.select()
  const close = (): void => {
    box.classList.remove('open')
    box.innerHTML = ''
  }
  box.querySelector('#rn-close')?.addEventListener('click', close)
  box.querySelector('#rn-cancel')?.addEventListener('click', close)
  const save = (): void => {
    const v = input?.value.trim() ?? ''
    if (v) renamePack(packId, v)
    close()
    renderHome()
  }
  box.querySelector('#rn-save')?.addEventListener('click', save)
  input?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') save()
  })
}

function enterPack(id: string): void {
  setActivePackId(id)
  markStudied(id)
  location.hash = '#study'
  location.reload()
}

/* ---------------- 布局 ---------------- */

function mount(): void {
  $('#app').innerHTML = `
    <div id="home"></div>
    <div class="shell" id="study">
      <header>
        <div class="brand">GapGraph<span>缺口图谱</span></div>
        <div class="stats">
          <span>距离考试 <b id="days">—</b> 天</span>
          <span>已测 <b id="coverage">0/0</b></span>
          <span>预估 <b id="estimate">—</b></span>
        </div>
        <div class="spacer"></div>
        <div class="views">
          <button data-view="graph" aria-pressed="true">图谱</button>
          <button data-view="heat" aria-pressed="false">热力表</button>
        </div>
        <div class="modes g-only">
          <button data-mode="structure" aria-pressed="true">① 结构</button>
          <button data-mode="gap" aria-pressed="false">② 缺口</button>
        </div>
        <button class="ghost small h-only" id="heat-sort">缺口优先</button>
        <button class="ghost small g-only" id="guide-btn">指南</button>
        <button class="ghost small g-only" id="fold" aria-pressed="true">折叠</button>
        <button class="ghost small g-only" id="relayout">重排</button>
        <button class="ghost small g-only" id="add-node">＋考点</button>
        <button class="ghost small" id="diag">摸底</button>
        <button class="ghost small" id="cards-btn">卡片 0</button>
        <button class="ghost small" id="chapter-btn">章节</button>
        <button class="ghost small" id="lobby-btn">大厅</button>
        <button class="ghost small" id="settings-btn">设置</button>
      </header>
      <main>
        <aside id="today"></aside>
        <section id="stage">
          <svg id="graph" data-mode="structure"></svg>
          <div class="legend">
            <span><i style="background:var(--c1)"></i>塌了</span>
            <span><i style="background:var(--c2)"></i>不稳</span>
            <span><i style="background:var(--c3)"></i>勉强</span>
            <span><i style="background:var(--c5)"></i>稳</span>
            <span><i style="background:var(--c0)"></i>没测过</span>
            <span><span class="line"></span>结构（谁是谁的下一层）</span>
            <span><span class="line pre"></span>前置（要先会）</span>
            <span><span class="line con"></span>易混（点节点看）</span>
            <span class="hint">节点可拖动摆位置</span>
          </div>
          <div id="heat"></div>
        </section>
        <aside id="panel"></aside>
      </main>
    </div>
    <div id="modal"></div>
    <div id="guide"></div>
    <div id="settings"></div>
    <div id="cards"></div>
    <div id="wizard"></div>
  `

  $('#guide-btn').addEventListener('click', () => renderGuide())
  $('#settings-btn').addEventListener('click', () => renderSettings())
  $('#cards-btn').addEventListener('click', () => renderCards())
  $('#chapter-btn').addEventListener('click', () => renderWizard())
  $('#lobby-btn').addEventListener('click', () => {
    location.hash = ''
    location.reload()
  })

  graph = new KnowledgeGraph($('#graph') as unknown as SVGSVGElement, {
    onSelect: (id) => selectNode(id),
    // 拖完立刻记下来，下次打开还在原地
    onMoveNode: (id, x, y) => {
      saveOnePosition(pack.packId, id, x, y)
    }
  })
  graph.setMode('structure')

  document.querySelectorAll<HTMLButtonElement>('.modes button').forEach((b) => {
    b.addEventListener('click', () => {
      mode = b.dataset.mode as GraphMode
      document.querySelectorAll<HTMLButtonElement>('.modes button').forEach((x) => {
        x.setAttribute('aria-pressed', String(x === b))
      })
      graph.setMode(mode)
    })
  })
  $('#diag').addEventListener('click', () => startDiagnostic())
  $('#add-node')?.addEventListener('click', () => addNodeInteractive())
  $('#relayout')?.addEventListener('click', () => {
    clearPositions(pack.packId)
    graph.resetLayout()
  })

  document.querySelectorAll<HTMLButtonElement>('.views button').forEach((b) => {
    b.addEventListener('click', () => setView(b.dataset.view as 'graph' | 'heat'))
  })
  $('#heat-sort').addEventListener('click', (ev) => {
    heatSort = heatSort === 'priority' ? 'tree' : 'priority'
    const btn = ev.currentTarget as HTMLButtonElement
    btn.textContent = heatSort === 'priority' ? '缺口优先' : '结构顺序'
    renderHeat()
  })
  document.body.dataset.view = 'graph'
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTopOverlay()
  })
  $('#fold').addEventListener('click', (e) => {
    const next = !graph.isFolded()
    graph.setFold(next)
    ;(e.currentTarget as HTMLButtonElement).setAttribute('aria-pressed', String(next))
    graph.fit()
  })
}

/* ---------------- 渲染 ---------------- */

function renderHeader(): void {
  $('#days').textContent = String(overview.daysLeft)
  $('#coverage').textContent = `${overview.coverage.measured}/${overview.coverage.total}`
  // 一条数据都没有时不显示预估分，避免"什么都没做就有 103 分"的假精确
  $('#estimate').textContent =
    overview.coverage.measured === 0 ? '还没数据' : `${overview.estimate} ± ${overview.band}`
  const btn = $('#cards-btn')
  if (btn) btn.textContent = `卡片 ${loadCards().length}`
}

/* ---------------- 我的卡片 ---------------- */

function renderCards(): void {
  const box = $('#cards')
  const cards = loadCards().sort((a, b) => b.at - a.at)
  const typeName: Record<string, string> = { conclusion: '结论', method: '方法', pitfall: '易错', formula: '公式' }

  box.innerHTML = `
    <div class="gsheet" style="width:min(680px,92vw)">
      <div class="ghead">
        <div>
          <h2>我的卡片</h2>
          <div class="gsub">共 ${cards.length} 张 · 从考点讲解里收藏的</div>
        </div>
        <button class="ghost small" id="cards-close">关闭</button>
      </div>
      ${
        cards.length === 0
          ? `<div class="panel-empty" style="margin-top:18px">还没有收藏。点开任意一个考点，讲解下面有卡片，点 ☆ 就能存下来。</div>`
          : `<div class="cardlist">${cards
              .map(
                (c) => `<div class="aicard">
                  <div class="achead">
                    <span class="actype ${c.type}">${typeName[c.type] ?? c.type}</span>
                    <span class="acfrom">${esc(c.nodeName)}</span>
                    <button class="star on" data-del="${encodeURIComponent(c.nodeId)}|${encodeURIComponent(c.front)}" title="删除">★</button>
                  </div>
                  <div class="acfront">${esc(c.front)}</div>
                  <div class="acback">${esc(c.back)}</div>
                </div>`
              )
              .join('')}</div>`
      }
    </div>
  `
  box.classList.add('open')
  box.onclick = (e) => {
    if (e.target === box) closeCards()
  }
  box.querySelector('#cards-close')?.addEventListener('click', () => closeCards())
  box.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) => {
    b.addEventListener('click', () => {
      const [nodeId, front] = decodeURIComponent(b.dataset.del as string).split('|')
      removeCard(nodeId, front)
      renderCards()
      renderHeader()
      renderPanel()
    })
  })
}

function closeCards(): void {
  const box = $('#cards')
  box.classList.remove('open')
  box.innerHTML = ''
}

function renderToday(): void {
  const box = $('#today')
  const rows = today.map((t) => {
    const n = nodeById(t.nodeId)
    return `
      <div class="card ${t.status === 'done' ? 'done' : ''}" data-task="${t.id}">
        <div class="kind">${KIND_LABEL[t.kind]} · 约 ${t.estMinutes} 分钟</div>
        <div class="name">${esc(n?.name ?? t.nodeId)}</div>
        <div class="meta">${t.questionIds.length} 道题${t.status === 'done' ? ' · 已完成' : ''}</div>
        <div class="actions">
          <button class="primary small" data-start="${t.id}">开始</button>
          <button class="ghost small" data-postpone="${t.id}">推迟</button>
        </div>
      </div>`
  })
  box.innerHTML = `
    ${
      today.length === 0 && questions.length === 0
        ? `<div class="card intro">
             <div class="kind">这一章还没有题库</div>
             <div class="name">先给考点打标</div>
             <div class="meta">AI 生成的章节暂时没有配套题目。点开任意一个圆，选「学过不会 / 会」，图上就会先有颜色；也可以直接问 AI 讲解。</div>
           </div>`
        : !pack.nodes.some((n) => n.kind !== 'root' && band(masteryOf(n.id), Date.now()) !== 'unmeasured')
          ? `<div class="card intro">
             <div class="kind">第一步</div>
             <div class="name">先花 10 分钟做个摸底</div>
             <div class="meta">12–15 道题，软件会挑你大概七成能做对的题。做完就知道这张图上哪儿是塌的。</div>
             <div class="actions"><button class="primary small" id="diag-start">开始摸底</button></div>
           </div>`
          : ''
    }
    <div class="col-title">今天要做（${today.filter((t) => t.status !== 'done').length}/${today.length}）</div>
    ${rows.join('') || `<div class="panel-empty">${
      questions.length === 0
        ? '这一章没有题库，排不出「做题」任务。先给考点打标，或者直接问 AI 讲解。'
        : '今天没有安排。点右上角「设置 → 重排今日任务」重新生成。'
    }</div>`}
    <div class="hint">上限 ${state.settings.dailyMinutes} 分钟 · 装不下就不排</div>
  `
  box.querySelector('#diag-start')?.addEventListener('click', () => startDiagnostic())
  box.querySelectorAll<HTMLButtonElement>('[data-start]').forEach((b) => {
    b.addEventListener('click', async () => {
      const task = today.find((t) => t.id === b.dataset.start)
      if (!task) return
      // 这张卡的考点还没题 → 现出题（用户点"开始"的这一刻才算真的要用了）
      if (task.questionIds.length === 0) {
        b.textContent = '准备题目…'
        b.disabled = true
        const ok = await ensureQuestions(task.nodeId, 3)
        b.textContent = ok ? '开始' : '没有题目'
        b.disabled = !ok
        if (!ok) {
          alert('这个考点还没有题。需要开着 AI 服务（node scripts/ai-proxy.cjs）才能现出题。')
          renderToday()
          return
        }
        const fresh = questionsOf(task.nodeId).slice(0, 3).map((q) => q.id)
        openPractice(fresh, task.nodeId, task.id)
        return
      }
      openPractice(task.questionIds, task.nodeId, task.id)
    })
  })
  box.querySelectorAll<HTMLButtonElement>('[data-postpone]').forEach((b) => {
    b.addEventListener('click', async () => {
      const r = await api.postponeTask(b.dataset.postpone as string)
      state = r.state
      today = r.today
      overview = r.overview
      renderToday()
      renderHeader()
    })
  })
}

function renderPanel(): void {
  const box = $('#panel')
  if (!selectedId) {
    box.innerHTML = `
      <div class="panel-empty">
        点图上的任意一个圆，这里会显示它的讲解、掌握度和可做的题。
        <ul>
          <li>圆越红说明缺口越大</li>
          <li>灰色表示还没测过，不是「会」</li>
          <li>圆里的数字是掌握分</li>
        </ul>
      </div>`
    return
  }
  const n = nodeById(selectedId)
  if (!n) return
  const m = masteryOf(n.id)
  const now = Date.now()
  const eff = effective(m, now)
  const b = band(m, now)
  const touched = m.n > 0 || m.K > 0
  const qs = questions.filter((q) => q.tags.some((t) => t.nodeId === n.id))
  // 没有题时，能不能现场出题决定按钮是"可点"还是"灰掉"
  const aiReady = endpointStatus()
  const canGen = aiReady.reachable && aiReady.supportsQuestions

  box.innerHTML = `
    <h2 class="node-name">${esc(n.name)}${
      n.kind === 'root'
        ? ''
        : `<button class="node-del" id="del-node" title="删除这个考点">✕</button>`
    }</h2>
    <div class="node-path">${esc(pathOf(n.id))}</div>
    <div class="score-row">
      <div class="score-big ${touched ? '' : 'na'}">${touched ? eff.M.toFixed(2) : '未测'}</div>
      <div class="pill" style="border-color:${BAND_COLOR[b]};color:${BAND_COLOR[b]}">${b === 'unmeasured' ? '没测过' : '当前掌握'}</div>
      <div class="pill">可信度 ${(eff.conf * 100).toFixed(0)}%</div>
    </div>
    <div class="bar"><i style="width:${Math.round(eff.M * 100)}%;background:${BAND_COLOR[b]}"></i></div>
    <div class="hint">做过 ${m.n} 题 · 对 ${m.nok} 题 · 考频权重 ${n.examWeight.toFixed(2)}${m.misconception ? ' · 存在固化错误概念' : ''}</div>

    <div class="block">
      <h3>讲解</h3>
      <p>${esc((AI_CONTENT.byNode[n.id]?.explain ?? n.brief) ?? '（暂无讲解）')}</p>
    </div>

    ${(() => {
      const cards = AI_CONTENT.byNode[n.id]?.cards ?? []
      if (!cards.length) return ''
      const typeName: Record<string, string> = { conclusion: '结论', method: '方法', pitfall: '易错', formula: '公式' }
      return `<div class="block">
          <h3>卡片 <span class="hint">（点 ☆ 收藏，之后在顶栏「卡片」里能翻）</span></h3>
          ${cards
            .map((c) => {
              const saved = isSaved(n.id, c.front)
              return `<div class="aicard">
                <div class="achead">
                  <span class="actype ${c.type}">${typeName[c.type] ?? c.type}</span>
                  <button class="star ${saved ? 'on' : ''}" data-star="${encodeURIComponent(c.front)}" title="${saved ? '取消收藏' : '收藏这张卡'}">${saved ? '★' : '☆'}</button>
                </div>
                <div class="acfront">${esc(c.front)}</div>
                <div class="acback">${esc(c.back)}</div>
              </div>`
            })
            .join('')}
        </div>`
    })()}

    ${(() => {
      const a = attributionLine(n, state.attempts, state.mastery, pack.nodes, now)
      if (!a) return ''
      return `<div class="block">
          <h3>你主要错在</h3>
          <p><b>${a.label}</b><span class="hint"> · ${a.total} 次错题里有 ${a.count} 次</span></p>
          <p class="hint" style="margin-top:6px">
            建议：${a.suggestion.text}
            ${a.suggestion.goto ? `<span class="chip" data-goto="${a.suggestion.goto}">去看「${nodeById(a.suggestion.goto)?.name ?? ''}」</span>` : ''}
          </p>
        </div>`
    })()}

    <div class="block">
      <h3>还有疑问？直接问 AI</h3>
      ${(() => {
        const ai = endpointStatus()
        if (!ai.endpoint || !ai.reachable) {
          const why = ai.endpoint ? `连不上 ${esc(ai.endpoint)}` : '未检测到 AI 服务'
          return `<div class="hint">实时 AI 未连接（${why}）。先运行 <code>node scripts/ai-proxy.cjs</code>，再到「设置 → AI 服务地址」填 <code>http://127.0.0.1:3300</code>。<br>（不连也能用：上面的讲解和卡片是预生成好的，离线可看）</div>`
        }
        const st = askState && askState.nodeId === n.id ? askState : null
        return `
          <div class="askrow">
            <input id="ask-input" placeholder="比如：为什么这里要取对数？" ${st?.loading ? 'disabled' : ''} />
            <button class="primary small" id="ask-btn" ${st?.loading ? 'disabled' : ''}>${st?.loading ? '思考中…' : '问'}</button>
          </div>
          ${
            st?.error
              ? `<div class="hint" style="color:#a52222;margin-top:8px">${esc(st.error)}</div>`
              : ''
          }
          ${
            st?.answer
              ? `<div class="aianswer">
                   <div class="aatext">${esc(st.answer.answer)}</div>
                   ${st.answer.cards
                     .map(
                       (c) => `<div class="aicard" style="margin-top:8px">
                         <div class="achead"><span class="actype ${c.type}">卡片</span>
                         <button class="star ${isSaved(n.id, c.front) ? 'on' : ''}" data-star="${encodeURIComponent(c.front)}" data-json="${encodeURIComponent(JSON.stringify(c))}">${isSaved(n.id, c.front) ? '★' : '☆'}</button></div>
                         <div class="acfront">${esc(c.front)}</div>
                         <div class="acback">${esc(c.back)}</div>
                       </div>`
                     )
                     .join('')}
                   <div class="hint" style="margin-top:6px">${st.answer.ms}ms</div>
                 </div>`
              : ''
          }`
      })()}
    </div>

    <div class="block">
      <h3>你学过吗</h3>
      <div class="chiprow" id="rate">
        <span class="chip" data-level="0">没学过</span>
        <span class="chip" data-level="1">学过不会</span>
        <span class="chip" data-level="2">会</span>
      </div>
      <div class="hint">自评只给初值：「会」也只按 0.6 起算，余量留给做题证据。</div>
    </div>

    ${
      foundationChain(n.id).length
        ? `<div class="block">
             <h3>地基链（按顺序先补这些）</h3>
             <div class="chain">${foundationChain(n.id)
               .map((p) => `<span class="chip" data-goto="${p}">${nodeById(p)?.name ?? p}</span>`)
               .join('<span class="sep">→</span>')}<span class="sep">→</span><span class="here">${n.name}</span></div>
           </div>`
        : ''
    }

    ${
      n.prereq.length
        ? `<div class="block"><h3>前置（不会它，这一节学不动）</h3><ul class="rels">${n.prereq
            .map(
              (p) =>
                `<li><span class="chip" data-goto="${p}">${nodeById(p)?.name ?? p}</span><span class="why">${whyOf(p, n.id, 'prereq')}</span></li>`
            )
            .join('')}</ul></div>`
        : ''
    }

    ${
      n.confusable.length
        ? `<div class="block"><h3>容易混（放在一起对比练）</h3><ul class="rels">${n.confusable
            .map(
              (p) =>
                `<li><span class="chip conf" data-goto="${p}">⇄ ${nodeById(p)?.name ?? p}</span><span class="why">${whyOf(n.id, p, 'confusable')}</span></li>`
            )
            .join('')}</ul></div>`
        : ''
    }

    <div class="block">
      <h3>题目</h3>
      <p style="font-size:13px">${
        qs.length
          ? `这个考点已有 ${qs.length} 道题`
          : canGen
            ? '这个考点还没有题。点下面的按钮，现出 3 道（约 6 秒）——不预生成，用到才出。'
            : '这个考点还没有题。运行 <code>node scripts/ai-proxy.cjs</code> 并刷新页面，就能现场出题。'
      }</p>
      <div style="margin-top:8px">
        <button class="primary small" id="practice" ${qs.length || canGen ? '' : 'disabled'}>${
          qs.length ? '做 3 道' : canGen ? '现出 3 道题' : '做 3 道'
        }</button>
      </div>
    </div>
  `

  box.querySelectorAll<HTMLElement>('[data-goto]').forEach((c) => {
    c.addEventListener('click', () => selectNode(c.dataset.goto as string))
  })
  box.querySelector('#del-node')?.addEventListener('click', () => deleteNodeInteractive(n.id))
  box.querySelectorAll<HTMLButtonElement>('[data-star]').forEach((b) => {
    b.addEventListener('click', (ev) => {
      ev.stopPropagation()
      const front = decodeURIComponent(b.dataset.star as string)
      const rawJson = b.dataset.json
      const card = rawJson
        ? (JSON.parse(decodeURIComponent(rawJson)) as { type: string; front: string; back: string })
        : (AI_CONTENT.byNode[n.id]?.cards ?? []).find((c) => c.front === front)
      if (!card) return
      if (isSaved(n.id, front)) removeCard(n.id, front)
      else addCard({ nodeId: n.id, nodeName: n.name, type: card.type, front: card.front, back: card.back })
      renderPanel()
      renderHeader()
    })
  })

  const askBtn = box.querySelector<HTMLButtonElement>('#ask-btn')
  if (askBtn) {
    const submitAsk = async (): Promise<void> => {
      const input = box.querySelector<HTMLInputElement>('#ask-input')
      const question = (input?.value ?? '').trim()
      if (!question) return
      askState = { nodeId: n.id, loading: true }
      renderPanel()
      try {
        const explain = AI_CONTENT.byNode[n.id]?.explain ?? n.brief ?? ''
        const res = await askAi({ nodeName: n.name, nodePath: pathOf(n.id), explain, question })
        askState = res
          ? { nodeId: n.id, loading: false, answer: res }
          : { nodeId: n.id, loading: false, error: '实时 AI 未连接' }
      } catch (e) {
        askState = { nodeId: n.id, loading: false, error: `请求失败：${(e as Error).message}` }
      }
      renderPanel()
    }
    askBtn.addEventListener('click', () => void submitAsk())
    box.querySelector('#ask-input')?.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void submitAsk()
    })
  }
  box.querySelectorAll<HTMLElement>('#rate .chip').forEach((c) => {
    c.addEventListener('click', async () => {
      const level = Number(c.dataset.level) as 0 | 1 | 2
      const r = await api.rate(n.id, level)
      state = r.state
      today = r.today
      overview = r.overview
      renderToday()
      renderHeader()
      renderPanel()
      refreshVisuals()
    })
  })
  const pbtn = box.querySelector<HTMLButtonElement>('#practice')
  pbtn?.addEventListener('click', async () => {
    const have = questionsOf(n.id)
    if (have.length > 0) {
      openPractice(have.slice(0, 3).map((q) => q.id), n.id, null)
      return
    }
    // 题不够 → 现出题。这是"按需生成"的主入口。
    pbtn.textContent = '正在出题…'
    pbtn.disabled = true
    const ok = await ensureQuestions(n.id, 3)
    if (!ok) {
      pbtn.textContent = '出题失败'
      const ai = endpointStatus()
      alert(
        ai.reachable && ai.supportsQuestions
          ? '出题没成功，可以再点一次。'
          : '这个考点还没有题。运行 node scripts/ai-proxy.cjs 并刷新，就能现场出题。'
      )
      renderPanel()
      return
    }
    renderPanel()
    const fresh = questionsOf(n.id)
    if (fresh.length) openPractice(fresh.slice(0, 3).map((q) => q.id), n.id, null)
  })
}

function selectNode(id: string | null): void {
  selectedId = id
  graph.select(id)
  renderPanel()
}

/* ---------------- 热力表 ---------------- */

let heatSort: 'priority' | 'tree' = 'priority'

const CELL_CLASS = (r: number | null): string => {
  if (r === null) return 'none'
  if (r < 0.4) return 'bad'
  if (r < 0.7) return 'mid'
  if (r < 0.9) return 'ok'
  return 'good'
}

function renderHeat(): void {
  const box = $('#heat')
  const now = Date.now()
  const rows = buildHeatmap({
    nodes: pack.nodes,
    questions,
    attempts: state.attempts,
    mastery: state.mastery,
    now,
    daysLeft: overview.daysLeft,
    sort: heatSort
  })
  const sum = summarizeHeat(rows)

  const body = rows
    .map((r) => {
      const cells = BANDS.map((b) => {
        const c = r.cells[b.key]
        return `<td class="hcell ${CELL_CLASS(c.ratio)}" title="${b.hint}：${c.correct}/${c.attempts}">
                  ${c.ratio === null ? '—' : `${c.correct}/${c.attempts}`}
                </td>`
      }).join('')
      const m = r.mastery === null ? '<span class="hm none">没测过</span>' : `<span class="hm" style="background:${bandColor(r.mastery)}"></span>${r.mastery.toFixed(2)}`
      const conf = r.mastery === null ? '—' : `${Math.round(r.conf * 100)}%`
      return `<tr data-node="${r.nodeId}" class="${selectedId === r.nodeId ? 'sel' : ''}">
        <td class="hname">
          ${r.parentName ? `<span class="hpath">${esc(r.parentName)}</span>` : ''}${esc(r.name)}
        </td>
        ${cells}
        <td class="hnum">${m}</td>
        <td class="hnum conf">${conf}</td>
      </tr>`
    })
    .join('')

  box.innerHTML = `
    <div class="hbar">
      <b>${sum.total}</b> 个考点 ·
      <b class="warn">${sum.gaps}</b> 个塌了 ·
      <b>${sum.unmeasured}</b> 个没测过
      <span class="hsep">|</span>
      格子里的「2/3」= 这个难度做对 2 次共 3 次；「—」表示还没做过这个难度
    </div>
    <table class="heat">
      <thead>
        <tr>
          <th class="hname">考点</th>
          ${BANDS.map((b) => `<th title="${b.hint}">${b.label}</th>`).join('')}
          <th>掌握</th>
          <th>可信度</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  `

  box.querySelectorAll<HTMLElement>('tr[data-node]').forEach((tr) => {
    tr.addEventListener('click', () => {
      selectNode(tr.dataset.node as string)
      renderHeat()
    })
  })
}

function bandColor(m: number): string {
  if (m < 0.25) return 'var(--c1)'
  if (m < 0.4) return 'var(--c2)'
  if (m < 0.6) return 'var(--c3)'
  return 'var(--c5)'
}

function refreshVisuals(): void {
  graph.setData(pack.nodes, state.mastery, Date.now(), pack.relations ?? [])
  // 用户拖过的位置要钉回去，否则每次刷新又乱了
  graph.setPositions(loadPositions(pack.packId))
  if (document.body.dataset.view === 'heat') renderHeat()
}

/* ---------------- 增删考点 ---------------- */

/** 选中了节点就加在它下面，没选就挂在根上 */
function addNodeInteractive(): void {
  const root = pack.nodes.find((n) => n.kind === 'root') ?? pack.nodes[0]
  const parentId = selectedId ?? root?.id ?? null
  const parentName = parentId ? (nodeById(parentId)?.name ?? '') : ''
  const name = prompt(
    parentName ? `在「${parentName}」下面加一个考点，名字是：` : '新增一个考点，名字是：',
    ''
  )
  if (!name || !name.trim()) return
  const node: KNode = {
    id: `u_${Date.now().toString(36)}`,
    name: name.trim().slice(0, 24),
    parentId: parentId ?? null,
    kind: 'concept',
    examWeight: 0.5,
    prereq: [],
    confusable: [],
    brief: ''
  }
  addUserNode(pack.packId, node)
  pack.nodes.push(node)
  state.mastery[node.id] = freshMastery(0)
  refreshVisuals()
  renderPanel()
  renderToday()
  selectNode(node.id)
}

function deleteNodeInteractive(id: string): void {
  const n = nodeById(id)
  if (!n) return
  if (n.kind === 'root') {
    alert('根节点不能删。可以给板块改名，或者删掉整个板块。')
    return
  }
  const kids = pack.nodes.filter((x) => x.parentId === id)
  const msg = kids.length
    ? `删除「${n.name}」？它下面的 ${kids.length} 个考点会上移到上一层，不会被一起删掉。`
    : `删除「${n.name}」？`
  if (!confirm(msg)) return

  removeUserNode(pack.packId, id)
  const rest = pack.nodes.filter((x) => x.id !== id)
  const parentId = n.parentId
  for (const x of rest) {
    if (x.parentId === id) x.parentId = parentId
    x.prereq = x.prereq.filter((p) => p !== id)
    x.confusable = x.confusable.filter((p) => p !== id)
  }
  pack.nodes = rest
  if (pack.relations) pack.relations = pack.relations.filter((r) => r.a !== id && r.b !== id)
  delete state.mastery[id]
  refreshVisuals()
  selectNode(parentId)
  renderToday()
}

function setView(view: 'graph' | 'heat'): void {  document.body.dataset.view = view
  document.querySelectorAll<HTMLButtonElement>('.views button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.view === view))
  })
  if (view === 'heat') renderHeat()
  else graph.fit()
}

/* ---------------- 做题 ---------------- */

interface Session {
  ids: string[]
  index: number
  taskId: string | null
  startedAt: number
  answer: string
  confidence: 'sure' | 'unsure'
  /** answering → (错了才进 reason) → feedback */
  phase: 'answering' | 'reason' | 'feedback'
  last?: SubmitResult
  /** 摸底模式：题目是边测边挑的，不是固定列表 */
  diag?: DiagState
}

let session: Session | null = null
let diagResult: DiagSummary | null = null

function startDiagnostic(): void {
  if (questions.length === 0) {
    alert('这一章还没有题库，先用「你学过吗」自评打标，或者直接问 AI 讲解。')
    return
  }
  const diag = createDiagnostic()
  const first = nextQuestion(diag, questions, pack.nodes, state.mastery)
  if (!first) return
  diagResult = null
  session = {
    ids: [first.id],
    index: 0,
    taskId: null,
    startedAt: Date.now(),
    answer: '',
    confidence: 'unsure',
    phase: 'answering',
    diag
  }
  renderModal()
}

function finishDiagnostic(): void {
  if (!session?.diag) return
  diagResult = summarize(session.diag, pack.nodes, state.mastery, Date.now())
  session = null
  renderModal()
}

async function closeDiagnostic(goWeakest: boolean): Promise<void> {
  const weak = diagResult?.weakest[0]
  diagResult = null
  renderModal()
  const r = await api.rebuildQueue()
  today = r.today
  overview = r.overview
  renderToday()
  renderHeader()
  if (goWeakest && weak) selectNode(weak.id)
}

function openPractice(ids: string[], nodeId: string | null, taskId: string | null): void {
  if (!ids.length) return
  session = { ids, index: 0, taskId, startedAt: Date.now(), answer: '', confidence: 'sure', phase: 'answering' }
  if (nodeId) selectNode(nodeId)
  renderModal()
}

function renderModal(): void {
  const box = $('#modal')

  // 摸底结果页
  if (diagResult) {
    const bad = diagResult.bands.red + diagResult.bands.orange
    box.innerHTML = `
      <div class="sheet">
        <div class="qhead"><span>摸底完成</span><span>${diagResult.answered} 道题</span></div>
        <div class="stem">测了 <b>${diagResult.touched}</b> 个考点：<b>${bad}</b> 处塌了、${diagResult.bands.yellow} 处不稳、${diagResult.bands.green} 处还行。</div>
        ${
          diagResult.weakest.length
            ? `<div class="block"><h3>最薄的三处（点一下定位到图上）</h3>
                 <div class="chiprow">${diagResult.weakest
                   .map((w) => `<span class="chip" data-weak="${w.id}">${w.name}</span>`)
                   .join('')}</div>
               </div>`
            : ''
        }
        <div class="footer-row">
          <div class="spacer"></div>
          <button class="primary" id="diag-done">开始今天的三件事</button>
        </div>
      </div>`
    box.classList.add('open')
    box.querySelectorAll<HTMLElement>('[data-weak]').forEach((c) => {
      c.addEventListener('click', () => {
        const id = c.dataset.weak as string
        diagResult = null
        renderModal()
        selectNode(id)
      })
    })
    box.querySelector('#diag-done')?.addEventListener('click', () => void closeDiagnostic(true))
    return
  }

  if (!session) {
    box.classList.remove('open')
    box.innerHTML = ''
    return
  }
  const q = questions.find((x) => x.id === session!.ids[session!.index])!
  const total = session.ids.length
  const answered = session.phase === 'feedback'
  const askingReason = session.phase === 'reason'

  let inputHtml = ''
  if (askingReason) {
    inputHtml = ''
  } else if (q.type === 'single') {
    inputHtml = `<div class="opts">${(q.options ?? [])
      .map(
        (o, i) =>
          `<button class="opt ${session!.answer === o ? 'sel' : ''}" data-opt="${i}">${String.fromCharCode(65 + i)}. ${esc(o)}</button>`
      )
      .join('')}</div>`
  } else if (q.type === 'judge') {
    inputHtml = `<div class="opts">
      <button class="opt ${session!.answer === 'true' ? 'sel' : ''}" data-judge="true">正确</button>
      <button class="opt ${session!.answer === 'false' ? 'sel' : ''}" data-judge="false">错误</button>
    </div>`
  } else {
    inputHtml = `<input class="blank" id="blank" placeholder="输入答案，如：x>1、3/2、{0,2}" value="${session!.answer.replace(/"/g, '&quot;')}" />`
  }

  const fb =
    answered && session.last
      ? `<div class="feedback ${session.last.correct ? 'ok' : 'bad'}">
         <b>${session.last.correct ? '答对了' : '答错了'}</b>
         ${session.last.guessed ? ' · 这条不计入掌握分（疑似蒙对）' : ''}
         <span class="delta"> ${session.last.before.toFixed(2)} → ${session.last.after.toFixed(2)}</span>
         <span class="bandshift">${BAND_NAME[session.last.beforeBand]} → ${BAND_NAME[session.last.afterBand]}</span>
         ${session.last.solution ? `<div style="margin-top:6px;color:#444">${esc(session.last.solution)}</div>` : ''}
       </div>`
      : ''

  const reasonHtml = askingReason
    ? `<div class="reasonbox">
         <div class="rtitle">这题错在哪？<span>选一个，软件据此决定下次推什么</span></div>
         <div class="rchips">
           ${REASONS.map((r) => `<button class="rc" data-reason="${r.key}" title="${r.hint}">${r.label}</button>`).join('')}
         </div>
       </div>`
    : ''

  box.innerHTML = `
    <div class="sheet">
      <div class="qhead">
        <span>${session.diag ? `摸底 · 第 ${session.index + 1} 题` : `第 ${session.index + 1} / ${total} 题`} · 难度 ${'●'.repeat(q.difficulty)}</span>
        <span>${session.diag ? '边测边选题' : (KIND_LABEL[(today.find((t) => t.id === session!.taskId)?.kind ?? 'gap') as string] ?? '')}</span>
      </div>
      ${session.diag ? `<div class="diagbar"><i style="width:${Math.min(100, Math.round(((session.index + 1) / 15) * 100))}%"></i></div>` : ''}
      <div class="stem">${esc(q.stem)}</div>
      ${inputHtml}
      ${reasonHtml}
      ${fb}
      <div class="footer-row">
        ${
          answered
            ? `<button class="primary" id="next">${session.index + 1 < total ? '下一题' : '完成'}</button>`
            : askingReason
              ? `<span class="hint">跳过也能记，只是少了这条线索</span><div class="spacer"></div><button class="ghost small" id="skip-reason">跳过</button>`
              : `<div class="conf-toggle">
                 <button class="small" data-conf="sure" aria-pressed="${session.confidence === 'sure'}">我很确定</button>
                 <button class="small" data-conf="unsure" aria-pressed="${session.confidence === 'unsure'}">不确定</button>
               </div>
               <div class="spacer"></div>
               <button class="ghost small" id="later">${session.diag ? '退出摸底' : '稍后'}</button>
               <button class="primary" id="submit" ${session.answer ? '' : 'disabled'}>提交</button>`
        }
      </div>
    </div>`
  box.classList.add('open')

  box.querySelectorAll<HTMLButtonElement>('[data-reason]').forEach((b) => {
    b.addEventListener('click', () => void commitAnswer(b.dataset.reason as ErrorReason))
  })
  box.querySelector('#skip-reason')?.addEventListener('click', () => void commitAnswer(null))

  box.querySelectorAll<HTMLButtonElement>('[data-opt]').forEach((b) => {
    b.addEventListener('click', () => {
      session!.answer = q.options![Number(b.dataset.opt)]
      renderModal()
    })
  })
  box.querySelectorAll<HTMLButtonElement>('[data-judge]').forEach((b) => {
    b.addEventListener('click', () => {
      session!.answer = b.dataset.judge as string
      renderModal()
    })
  })
  box.querySelectorAll<HTMLButtonElement>('[data-conf]').forEach((b) => {
    b.addEventListener('click', () => {
      session!.confidence = b.dataset.conf as 'sure' | 'unsure'
      renderModal()
    })
  })
  const blank = box.querySelector<HTMLInputElement>('#blank')
  if (blank) {
    blank.addEventListener('input', () => {
      session!.answer = blank.value
      const s = box.querySelector<HTMLButtonElement>('#submit')
      if (s) s.disabled = !blank.value.trim()
    })
    blank.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && blank.value.trim()) void doSubmit()
    })
  }
  box.querySelector('#submit')?.addEventListener('click', () => void doSubmit())
  box.querySelector('#later')?.addEventListener('click', () => {
    session = null
    renderModal()
  })
  box.querySelector('#next')?.addEventListener('click', () => {
    if (!session) return
    if (session.index + 1 < session.ids.length) {
      session.index++
      session.answer = ''
      session.confidence = session.diag ? 'unsure' : 'sure'
      session.phase = 'answering'
      session.startedAt = Date.now()
      renderModal()
    } else if (session.diag) {
      finishDiagnostic()
    } else {
      void finishSession()
    }
  })
}

/** 先判对错（不改状态）：答错了先问一句"错在哪"，再落库 */
async function doSubmit(): Promise<void> {
  if (!session || session.phase !== 'answering') return
  const q = questions.find((x) => x.id === session!.ids[session!.index])!
  const { correct } = await api.check(q.id, session.answer)
  if (correct) {
    await commitAnswer(null)
  } else {
    session.phase = 'reason'
    renderModal()
  }
}

async function commitAnswer(reason: ErrorReason): Promise<void> {
  if (!session) return
  const q = questions.find((x) => x.id === session!.ids[session!.index])!
  const durationMs = Date.now() - session.startedAt
  const r = await api.submit({
    questionId: q.id,
    answer: session.answer,
    durationMs,
    selfConfidence: session.confidence,
    errorReason: reason
  })
  session.last = r
  session.phase = 'feedback'
  state = r.state
  today = r.today
  overview = r.overview

  // 摸底模式：根据这一题的对错，现场挑下一题（错了就下钻前置考点）
  if (session.diag) {
    const nodeId = primaryNodeOf(q)
    if (nodeId) session.diag = applyDiagAnswer(session.diag, q.id, nodeId, r.correct)
    const next = nextQuestion(session.diag, questions, pack.nodes, r.state.mastery)
    if (next) session.ids.push(next.id)
  }

  refreshVisuals()
  renderToday()
  renderHeader()
  renderPanel()
  renderModal()
}

async function finishSession(): Promise<void> {
  const taskId = session?.taskId ?? null
  session = null
  renderModal()
  if (taskId) {
    const r = await api.completeTask(taskId)
    state = r.state
    today = r.today
    overview = r.overview
    renderToday()
    renderHeader()
  }
}

/* ---------------- 启动 ---------------- */

async function boot(): Promise<void> {
  try {
    await bootInner()
  } catch (err) {
    // 启动失败时别留一个白屏给人猜：把错误直接摊在页面上
    console.error(err)
    document.body.insertAdjacentHTML(
      'beforeend',
      `<pre id="booterr" style="position:fixed;left:0;right:0;bottom:0;max-height:46%;overflow:auto;
        background:#fff3f3;color:#a11;border-top:2px solid #e88;font:12px/1.6 ui-monospace,monospace;
        padding:12px 16px;margin:0;white-space:pre-wrap;z-index:99">启动失败：${
          err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err)
        }</pre>`
    )
  }
}

async function bootInner(): Promise<void> {
  mount()
  await initEndpoint()

  const data = await api.load()
  pack = data.pack
  questions = data.questions
  state = data.state
  today = data.today
  overview = data.overview

  const hash = location.hash.replace('#', '')
  const wantsStudy = hash === 'study' || hash === 'diag' || hash === 'heat'
  const page = wantsStudy && currentPack() ? 'study' : 'home'
  document.body.dataset.page = page

  if (page === 'home') {
    renderHome()
    if (shouldShowGuide()) renderGuide()
    return
  }

  renderHeader()
  renderToday()
  renderPanel()
  refreshVisuals()
  requestAnimationFrame(() => graph.fit())
  setTimeout(() => graph.fit(), 80)

  const measured = pack.nodes.filter((n) => n.kind !== 'root' && masteryScore(masteryOf(n.id), Date.now()) > 0)
  if (measured.length === 0 && today.length > 0) selectNode(today[0].nodeId)

  // 深链：地址后加 #diag 直接进摸底、#heat 直接看热力表（方便演示与自测）
  if (hash === 'diag') startDiagnostic()
  else if (hash === 'heat') setView('heat')
  else if (hash === 'settings') renderSettings()
  else maybeAutoDiagnostic()
}

/**
 * 第一次进这个板块时，主动把摸底弹出来。
 * 理由：空白的图没有任何信息量，用户不知道下一步该干嘛；
 * 但**允许随时退出**——弹窗里的「退出摸底」会直接关掉，不会卡住。
 * 每个板块只自动弹一次。
 */
function maybeAutoDiagnostic(): void {
  if (!currentPack()) return
  if (questions.length === 0) return
  if (state.attempts.length > 0) return
  const key = `gapgraph.diag.auto.${pack.packId}`
  try {
    if (localStorage.getItem(key)) return
    localStorage.setItem(key, '1')
  } catch {
    return
  }
  startDiagnostic()
}

void boot()
