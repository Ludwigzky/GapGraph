/*
 * 浏览器运行模式：不依赖 Electron 主进程。
 * 与 Electron 版共用同一份领域算法（掌握度 / 优先级 / 队列 / 判分），
 * 区别只有两处：数据存在 localStorage，题库与考纲包由打包工具内联进来。
 */
import packJson from '../../../resources/packs/gaokao-math-function.json'
import questionsJson from '../../../resources/questions/gaokao-math-function.json'
import type { AppState, LoadResult, Mastery, Pack, Question, SubmitPayload, SubmitResult, Task } from '../../shared/types'
import { applyAttempt, band, effective, freshMastery, masteryScore } from '../../shared/mastery'
import { blankMastery, buildToday, coverage, daysUntil } from '../../main/domain/queue'
import { isCorrect } from '../../main/domain/grading'
import { builtinPack, currentPack, stateKeyFor } from './packs'
import { loadBank } from './qbank'

/** 当前生效的考纲：由引导流程选定，换了章节就换这一份；状态按 packId 隔离 */
const PACK: Pack = currentPack() ?? builtinPack()
const BUILTIN_ID = (packJson as unknown as Pack).packId
/** 内置题库 + 按需生成后缓存下来的题 */
const QUESTIONS: Question[] = [
  ...(PACK.packId === BUILTIN_ID ? (questionsJson as unknown as { questions: Question[] }).questions : []),
  ...loadBank(PACK.packId)
]
const KEY = stateKeyFor(PACK.packId)

function todayKey(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function defaultState(): AppState {
  return {
    settings: { dailyMinutes: 40, examDate: '2027-06-07', totalScore: PACK.totalScore, packId: PACK.packId },
    mastery: blankMastery(PACK.nodes),
    attempts: [],
    tasks: []
  }
}

/**
 * 存储层：优先 localStorage。
 * file:// 打开时浏览器可能禁用 localStorage，写失败不能让整个应用崩掉，
 * 所以退化成"内存里的状态"——功能全都能用，只是关掉页面不保留。
 */
let memoryState: AppState | null = null
let storageOk = true

function read(): AppState {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return memoryState ?? defaultState()
    const s = JSON.parse(raw) as AppState
    for (const n of PACK.nodes) {
      if (!s.mastery[n.id]) s.mastery[n.id] = freshMastery(n.kind === 'root' ? 1 : 0)
    }
    return s
  } catch {
    storageOk = false
    return memoryState ?? defaultState()
  }
}

function write(s: AppState): void {
  memoryState = s
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    storageOk = false
  }
}

export function storageHealthy(): boolean {
  return storageOk
}

function daysLeft(s: AppState, now: number): number {
  return daysUntil(s.settings.examDate, now)
}

function buildQueue(s: AppState, now: number): Task[] {
  return buildToday({
    nodes: PACK.nodes,
    questions: QUESTIONS,
    mastery: s.mastery,
    now,
    dailyMinutes: s.settings.dailyMinutes,
    daysLeft: daysLeft(s, now),
    date: todayKey(now)
  })
}

function ensureToday(s: AppState, now: number): Task[] {
  const key = todayKey(now)
  const existing = s.tasks.filter((t) => t.date === key)
  if (existing.length) return existing.sort((a, b) => a.sortOrder - b.sortOrder)
  const tasks = buildQueue(s, now)
  s.tasks = [...s.tasks.filter((t) => t.date !== key), ...tasks]
  write(s)
  return tasks
}

function overviewOf(s: AppState, now: number) {
  const cov = coverage(s, PACK.nodes)
  const effs = PACK.nodes
    .filter((n) => n.kind !== 'root')
    .map((n) => effective(s.mastery[n.id] ?? freshMastery(0), now).eff)
  const raw = effs.reduce((a, b) => a + b, 0) / Math.max(1, effs.length)
  const est = s.settings.totalScore * (0.55 + 0.45 * raw)
  return {
    coverage: cov,
    estimate: Math.round(est),
    band: Math.round(est * 0.09),
    daysLeft: daysLeft(s, now),
    todayKey: todayKey(now)
  }
}

export function createLocalApi() {
  return {
    async load(): Promise<LoadResult & { overview: ReturnType<typeof overviewOf> }> {
      const now = Date.now()
      const state = read()
      return { pack: PACK, questions: QUESTIONS, state, today: ensureToday(state, now), overview: overviewOf(state, now) }
    },

    async submit(payload: SubmitPayload): Promise<SubmitResult & { today: Task[]; overview: ReturnType<typeof overviewOf> }> {
      const now = Date.now()
      const state = read()
      const q = QUESTIONS.find((x) => x.id === payload.questionId)
      if (!q) throw new Error('题目不存在')

      const correct = isCorrect(q, payload.answer)
      const guessed = correct && payload.durationMs < 3000 && q.difficulty >= 3
      const primary = q.tags.find((t) => t.primary) ?? q.tags[0]
      const mBefore = state.mastery[primary.nodeId] ?? freshMastery(0)
      const before = masteryScore(mBefore, now)
      const beforeBand = band(mBefore, now)

      for (const tag of q.tags) {
        const m: Mastery = state.mastery[tag.nodeId] ?? freshMastery(0)
        const weight = tag.primary || correct ? tag.weight : tag.weight * 0.3
        state.mastery[tag.nodeId] = applyAttempt(m, {
          difficulty: q.difficulty,
          correct,
          weight,
          sure: payload.selfConfidence === 'sure',
          guessed,
          now,
          errorReason: correct ? null : payload.errorReason
        })
      }

      state.attempts.push({
        id: `a_${now}_${Math.random().toString(36).slice(2, 8)}`,
        questionId: q.id,
        nodePrimary: primary.nodeId,
        startedAt: now - payload.durationMs,
        submittedAt: now,
        durationMs: payload.durationMs,
        correct,
        selfConfidence: payload.selfConfidence,
        guessed,
        errorReason: correct ? null : payload.errorReason
      })

      const task = state.tasks.find((t) => t.status === 'pending' && t.questionIds.includes(q.id))
      if (task && correct) task.status = 'done'

      write(state)
      return {
        correct,
        nodeId: primary.nodeId,
        before,
        after: masteryScore(state.mastery[primary.nodeId], now),
        beforeBand,
        afterBand: band(state.mastery[primary.nodeId], now),
        guessed,
        solution: q.solution,
        state,
        today: ensureToday(state, now),
        overview: overviewOf(state, now)
      }
    },

    async completeTask(taskId: string) {
      const state = read()
      const t = state.tasks.find((x) => x.id === taskId)
      if (t) t.status = 'done'
      write(state)
      return { state, today: ensureToday(state, Date.now()), overview: overviewOf(state, Date.now()) }
    },

    async postponeTask(taskId: string) {
      const state = read()
      const t = state.tasks.find((x) => x.id === taskId)
      if (t) t.status = 'postponed'
      write(state)
      return { state, today: ensureToday(state, Date.now()), overview: overviewOf(state, Date.now()) }
    },

    async rebuildQueue() {
      const now = Date.now()
      const state = read()
      const key = todayKey(now)
      const tasks = buildQueue(state, now)
      state.tasks = [...state.tasks.filter((t) => t.date !== key), ...tasks]
      write(state)
      return { today: tasks, overview: overviewOf(state, now) }
    },

    async rate(nodeId: string, level: 0 | 1 | 2) {
      const state = read()
      const m = state.mastery[nodeId] ?? freshMastery(0)
      state.mastery[nodeId] = { ...m, K: level === 0 ? 0 : level === 1 ? 0.5 : 1, A: level === 2 ? 0.6 : m.A }
      write(state)
      const now = Date.now()
      return { state, today: ensureToday(state, now), overview: overviewOf(state, now) }
    },

    async check(questionId: string, answer: string) {
      const q = QUESTIONS.find((x) => x.id === questionId)
      if (!q) throw new Error('题目不存在')
      return { correct: isCorrect(q, answer) }
    },

    async updateSettings(patch: Partial<AppState['settings']>) {
      const state = read()
      const s = state.settings
      if (typeof patch.dailyMinutes === 'number') {
        s.dailyMinutes = Math.max(10, Math.min(240, Math.round(patch.dailyMinutes)))
      }
      if (typeof patch.examDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(patch.examDate)) {
        s.examDate = patch.examDate
      }
      if (typeof patch.totalScore === 'number' && patch.totalScore > 0) {
        s.totalScore = Math.round(patch.totalScore)
      }
      write(state)
      const now = Date.now()
      const key = todayKey(now)
      state.tasks = state.tasks.filter((t) => t.date !== key)
      const today = buildQueue(state, now)
      state.tasks = [...state.tasks, ...today]
      write(state)
      return { state, today, overview: overviewOf(state, now) }
    }
  }
}
