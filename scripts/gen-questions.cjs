/**
 * 题库生成（质量优先，慢一点没关系）
 *
 * 三道质量闸门：
 *   1. 结构校验 —— 选项不能重复、答案必须在选项里、难度在 1–5、解析不能空
 *   2. 独立复核 —— 把题干单独丢给模型再解一遍，答案不一致就丢弃重来
 *      （这一步是整条流水线里最值钱的：能自动抓出算错的题）
 *   3. 去重 + 答案位置均衡 —— 题干归一化后去重；选择题选项重新洗牌，避免答案全挤在 B/C
 *
 * 用法：
 *   node scripts/gen-questions.cjs                # 为所有考点补齐
 *   node scripts/gen-questions.cjs --only A,B3    # 只做指定考点
 *   node scripts/gen-questions.cjs --per 3        # 每个考点生成几道（默认 3）
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { qcProblems, verifyPromptFor } = require('./question-qc.cjs')

const PACK_FILE = 'resources/packs/gaokao-math-function.json'
const QFILE = 'resources/questions/gaokao-math-function.json'
const MODEL = 'deepseek-chat'

const argv = process.argv.slice(2)
const argOf = (name, def) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : def
}
const PER = Number(argOf('--per', '3'))
const ONLY = (argOf('--only', '') || '').split(',').filter(Boolean)
// 每个考点要覆盖的难度：2 常规、3 中档、4 压轴（热力表的"难"列靠它）
const TARGETS = PER >= 3 ? [2, 3, 4] : PER === 2 ? [2, 4] : [3]

/* ---------------- 密钥 ---------------- */
const cred = path.join(os.homedir(), '.dsh', '.credentials.yaml')
const rawCred = fs.readFileSync(cred, 'utf8')
const m = rawCred.match(/DEEPSEEK_API_KEY[\s\S]{0,200}?(sk-[A-Za-z0-9_\-]{10,})/) || rawCred.match(/(sk-[A-Za-z0-9_\-]{20,})/)
if (!m) {
  console.error('没找到 API key')
  process.exit(1)
}
const KEY = m[1]

/* ---------------- 答案归一化（与 src/main/domain/grading.ts 保持一致） ---------------- */
function normalize(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[≥]/g, '>=')
    .replace(/[≤]/g, '<=')
    .replace(/[≠]/g, '!=')
    .replace(/[−–—]/g, '-')
    .replace(/根号/g, '√')
    .replace(/[{}]/g, (c) => (c === '{' ? '(' : ')'))
    .replace(/[×✕✖]/g, '*')
    .replace(/[÷]/g, '/')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[，]/g, ',')
    .replace(/[。．.]$/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

function numeric(raw) {
  const s = normalize(raw)
  const frac = s.match(/^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/)
  if (frac) {
    const a = Number(frac[1])
    const b = Number(frac[2])
    return b === 0 ? null : a / b
  }
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s)
  return null
}

/** 去掉复核答案里多余的选项前缀："A. π" / "选项B：3" → "π" / "3" */
function stripChoiceLabel(s) {
  return String(s ?? '')
    .replace(/^\s*(选项)?\s*[A-Da-d]\s*[.、．:：)）]\s*/, '')
    .replace(/^\s*(选项)?\s*[A-Da-d]\s+/, '')
    .trim()
}

/** 两个答案是否等价：先比归一化字符串，再比数值 */
function sameAnswer(a, b) {
  const x = normalize(a)
  const y = normalize(b)
  if (!x || !y) return false
  if (x === y) return true
  const n1 = numeric(x)
  const n2 = numeric(y)
  return n1 !== null && n2 !== null && Math.abs(n1 - n2) < 1e-9
}

/**
 * 判定复核答案是否认可生成答案。
 * 复核模型经常只写字母（"C"）或带前缀（"C. 17 元"），
 * 这些都要映射回选项内容再比，否则会把对的题误杀。
 */
function verdictAgrees(question, verdictAnswer) {
  let v = String(verdictAnswer ?? '').trim()
  const bare = v.replace(/^\s*(选项)?\s*([A-Da-d])\s*$/, '$2')
  if (question.type === 'single' && Array.isArray(question.options)) {
    const letter = bare.toUpperCase()
    if (/^[A-D]$/.test(letter)) {
      const idx = 'ABCD'.indexOf(letter)
      return sameAnswer(question.options[idx], question.answer)
    }
    const stripped = stripChoiceLabel(v)
    if (sameAnswer(stripped, question.answer)) return true
    return question.options.some((o) => sameAnswer(o, stripped) && sameAnswer(o, question.answer))
  }
  v = stripChoiceLabel(v)
  return sameAnswer(v, question.answer)
}

/* ---------------- 模型调用 ---------------- */
async function ask(messages, temperature) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature,
      response_format: { type: 'json_object' },
      messages
    })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content ?? '{}'
  const tokens = (data.usage?.prompt_tokens || 0) + (data.usage?.completion_tokens || 0)
  return { json: JSON.parse(content), tokens }
}

const GEN_SYSTEM = `你是高考数学命题老师。只输出 JSON，不要任何解释文字。
你出的题必须：答案唯一、可验证、不依赖图表、题干自成一体、难度与要求一致。
难度含义：1=课本例题水平，2=常规练习题，3=高考中档题，4=高考压轴选择/填空，5=竞赛入门。
不要出"以下哪个正确"这种需要外部信息的题。`

function genPrompt(node, targets) {
  return `考点：${node.name}
简述：${node.brief || '（无）'}
考频权重：${node.examWeight}

请出 ${targets.length} 道题，难度**严格**按这个顺序：${targets.join('、')}
（difficulty 4 要真的到高考压轴选择/填空的水平，不要用简单题冒充）
题型从 single（四选一）、blank（填空）、judge（判断）里挑，同一批里不要全是同一种。
输出：
{"questions":[
  {"type":"single","difficulty":2,"stem":"...","options":["选项内容1","选项内容2","选项内容3","选项内容4"],"answer":"必须与某个选项完全一致","solution":"两三句话讲清怎么做"}
  {"type":"blank","difficulty":3,"stem":"...（用 ___ 表示空）","answer":"填空答案，简短","solution":"..."}
  {"type":"judge","difficulty":4,"stem":"判断：...","answer":"true 或 false","solution":"..."}
]}
注意：
- single 的 options 只写内容，不要写 A. B. 前缀
- 数学式用普通文本写清楚，不要 LaTeX
- 每个答案都能独立算出来，不要出现"以上都对"`
}

const VERIFY_SYSTEM = `你是高考数学阅卷老师。只输出 JSON。
你不看解析，独立把题做一遍。如果题目本身有歧义或算不出来，就如实标记 ambiguous。`

/* 复核提示词统一走 question-qc.cjs 的 verifyPromptFor：
   它按题型强制"先列中间结果再下结论"，比这里的旧版更能拦住系统性错误。 */

/* ---------------- 结构校验 ---------------- */
function validate(q) {
  const errs = []
  if (!q || typeof q !== 'object') return ['不是对象']
  if (!['single', 'blank', 'judge'].includes(q.type)) errs.push('题型非法')
  const d = Number(q.difficulty)
  if (!Number.isInteger(d) || d < 1 || d > 5) errs.push('难度非法')
  if (typeof q.stem !== 'string' || q.stem.trim().length < 6) errs.push('题干太短')
  if (typeof q.stem === 'string' && q.stem.length > 220) errs.push('题干太长')
  if (typeof q.solution !== 'string' || q.solution.trim().length < 6) errs.push('解析太短')

  if (q.type === 'single') {
    if (!Array.isArray(q.options) || q.options.length !== 4) errs.push('选项不是 4 个')
    else {
      const set = new Set(q.options.map((o) => normalize(o)))
      if (set.size !== 4) errs.push('选项有重复')
      if (q.options.some((o) => !String(o).trim())) errs.push('有空选项')
      const hit = q.options.some((o) => sameAnswer(o, q.answer))
      if (!hit) errs.push('答案不在选项里')
    }
  } else if (q.type === 'judge') {
    if (!['true', 'false'].includes(String(q.answer))) errs.push('判断题答案必须是 true/false')
  } else {
    if (!String(q.answer ?? '').trim()) errs.push('填空答案为空')
    if (String(q.answer).length > 40) errs.push('填空答案太长')
  }
  return errs
}

/* ---------------- 去重 ---------------- */
function stemKey(s) {
  return normalize(s).replace(/[\d]/g, '#').replace(/[^#\u4e00-\u9fa5a-z+\-*/=<>]/g, '')
}

/* ---------------- 主流程 ---------------- */
;(async () => {
  const pack = JSON.parse(fs.readFileSync(PACK_FILE, 'utf8'))
  const bank = JSON.parse(fs.readFileSync(QFILE, 'utf8'))
  const existing = bank.questions

  const targets = pack.nodes.filter(
    (n) => n.kind !== 'root' && (ONLY.length === 0 || ONLY.includes(n.id))
  )

  const seen = new Set(existing.map((q) => stemKey(q.stem)))
  const added = []
  const rejected = []
  let tokens = 0

  for (const node of targets) {
    process.stdout.write(`\n【${node.name}】\n`)
    const got = []
    const haveDiff = new Set()

    for (let attempt = 1; attempt <= 5 && got.length < PER; attempt++) {
      // 每轮只为"还缺的难度"出题，保证难点一定被覆盖
      const missing = TARGETS.filter((d) => !haveDiff.has(d))
      const targetsNow = got.length === 0 ? TARGETS : missing.length ? missing : [3]

      let batch
      try {
        const r = await ask(
          [
            { role: 'system', content: GEN_SYSTEM },
            { role: 'user', content: genPrompt(node, targetsNow) }
          ],
          0.85
        )
        tokens += r.tokens
        batch = Array.isArray(r.json.questions) ? r.json.questions : []
      } catch (e) {
        process.stdout.write(`  生成失败(${e.message})，重试\n`)
        continue
      }

      for (const q of batch) {
        if (got.length >= PER) break
        const errs = validate(q)
        if (errs.length) {
          rejected.push({ node: node.name, stem: q.stem, why: errs.join('；') })
          process.stdout.write(`  ✗ 结构 ${errs[0]}\n`)
          continue
        }
        const key = stemKey(q.stem)
        if (seen.has(key)) {
          process.stdout.write('  ✗ 重复题\n')
          continue
        }

        // 第二道闸门：独立复核（先把中间结果列出来，再下结论）
        let verdict
        try {
          const v = await ask(
            [
              { role: 'system', content: VERIFY_SYSTEM },
              { role: 'user', content: verifyPromptFor(q) }
            ],
            0.2
          )
          tokens += v.tokens
          verdict = v.json
        } catch (e) {
          process.stdout.write(`  ✗ 复核调用失败(${e.message})，丢弃\n`)
          continue
        }

        if (verdict.ambiguous) {
          rejected.push({ node: node.name, stem: q.stem, why: '复核认为题目有歧义' })
          process.stdout.write('  ✗ 复核：题目有歧义\n')
          continue
        }
        if (!verdictAgrees(q, verdict.answer)) {
          rejected.push({
            node: node.name,
            stem: q.stem,
            why: `复核答案不一致：生成=${q.answer} 复核=${verdict.answer}`
          })
          process.stdout.write(`  ✗ 答案不一致 生成「${q.answer}」复核「${verdict.answer}」\n`)
          continue
        }

        // 第三道闸门：解析自洽（确定性检查，不依赖模型）
        const qc = qcProblems(q)
        if (qc.length) {
          rejected.push({ node: node.name, stem: q.stem, why: `自洽检查：${qc.join('；')}` })
          process.stdout.write(`  ✗ 自洽检查：${qc.join('；')}\n`)
          continue
        }

        seen.add(key)
        haveDiff.add(Number(q.difficulty))
        got.push(q)
        added.push({ ...q, nodeId: node.id, verified: true })
        process.stdout.write(`  ✓ d${q.difficulty} ${q.type} ${String(q.stem).slice(0, 26)}…\n`)
      }
    }
    if (got.length < PER) process.stdout.write(`  （只拿到 ${got.length}/${PER} 道）\n`)
  }

  /* ---- 合并、洗牌、编号 ---- */
  const merged = [
    ...existing.map((q) => ({ ...q, from: q.from || 'builtin' })),
    ...added.map((q) => ({
      id: '',
      type: q.type,
      difficulty: q.difficulty,
      stem: q.stem,
      ...(q.options ? { options: q.options } : {}),
      answer: q.answer,
      solution: q.solution,
      tags: [{ nodeId: q.nodeId, weight: 1, primary: true }],
      from: 'ai',
      verified: true
    }))
  ]

  // 选择题选项洗牌：打散答案位置，避免全挤在 B/C
  const rotate = (arr, k) => arr.slice(k).concat(arr.slice(0, k))
  let shuffleSeed = 7
  const rnd = () => {
    shuffleSeed = (shuffleSeed * 1103515245 + 12345) % 2147483648
    return shuffleSeed / 2147483648
  }
  for (const q of merged) {
    if (q.type !== 'single' || !Array.isArray(q.options)) continue
    const k = Math.floor(rnd() * q.options.length)
    q.options = rotate(q.options, k)
  }

  merged.forEach((q, i) => {
    q.id = `q${String(i + 1).padStart(3, '0')}`
  })

  fs.writeFileSync(
    QFILE,
    JSON.stringify({ packId: pack.packId, questions: merged }, null, 2),
    'utf8'
  )

  /* ---- 报告 ---- */
  const byNode = {}
  for (const q of merged) for (const t of q.tags) (byNode[t.nodeId] ||= []).push(q)
  const holes = pack.nodes.filter((n) => n.kind !== 'root' && !byNode[n.id])
  const diff = {}
  for (const q of merged) diff[q.difficulty] = (diff[q.difficulty] || 0) + 1
  const pos = {}
  for (const q of merged) if (q.type === 'single') {
    const i = q.options.findIndex((o) => sameAnswer(o, q.answer))
    pos['ABCD'[i]] = (pos['ABCD'[i]] || 0) + 1
  }

  console.log('\n================ 结果 ================')
  console.log(`新增 ${added.length} 道 · 淘汰 ${rejected.length} 道 · 题库共 ${merged.length} 道 · ${tokens} tokens`)
  console.log('难度分布:', JSON.stringify(diff))
  console.log('选择题答案位置:', JSON.stringify(pos))
  console.log('仍无题的考点:', holes.length ? holes.map((n) => n.name).join(' ') : '无')
  if (rejected.length) {
    console.log('\n被淘汰的题（前 12 条）：')
    rejected.slice(0, 12).forEach((r) => console.log(`  · [${r.node}] ${r.why} — ${String(r.stem).slice(0, 40)}`))
  }
})()
