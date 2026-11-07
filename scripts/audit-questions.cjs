/**
 * 题库盲审：对已入库的每一道题独立再做一遍，答案不一致的列出来。
 *
 * 为什么入库后还要再审一次：
 *   生成时的复核和生成用的是同一个上下文（同一批话术、同一温度），
 *   模型可能有系统性偏差（比如总把某个公式记错），自己复核自己发现不了。
 *   这里换一套话术、降低温度再解一遍，专门抓这种情况。
 *
 * 用法：node scripts/audit-questions.cjs [--sample 20] [--write]
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const QFILE = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : 'resources/questions/gaokao-math-function.json'
const MODEL = 'deepseek-chat'

const cred = path.join(os.homedir(), '.dsh', '.credentials.yaml')
const rawCred = fs.readFileSync(cred, 'utf8')
const m = rawCred.match(/DEEPSEEK_API_KEY[\s\S]{0,200}?(sk-[A-Za-z0-9_\-]{10,})/) || rawCred.match(/(sk-[A-Za-z0-9_\-]{20,})/)
if (!m) {
  console.error('没找到 API key')
  process.exit(1)
}
const KEY = m[1]

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

function sameAnswer(a, b) {
  const x = normalize(a)
  const y = normalize(b)
  if (!x || !y) return false
  if (x === y) return true
  const n1 = numeric(x)
  const n2 = numeric(y)
  return n1 !== null && n2 !== null && Math.abs(n1 - n2) < 1e-9
}

function stripChoiceLabel(s) {
  return String(s ?? '')
    .replace(/^\s*(选项)?\s*[A-Da-d]\s*[.、．:：)）]\s*/, '')
    .replace(/^\s*(选项)?\s*[A-Da-d]\s+/, '')
    .trim()
}

/** 去掉 "y=" / "f(x)=" 这类前缀，只比右边 */
function dropPrefix(s) {
  return String(s ?? '').replace(/^\s*(y|f\s*\(\s*x\s*\))\s*=\s*/i, '').trim()
}

/** 题库答案可能是多解数组（["1","+1"]），要逐个比 */
function accepted(q) {
  return Array.isArray(q.answer) ? q.answer : [q.answer]
}

function looseEqual(a, b) {
  if (sameAnswer(a, b)) return true
  return sameAnswer(dropPrefix(a), dropPrefix(b))
}

function verdictAgrees(q, verdictAnswer) {
  const v = String(verdictAnswer ?? '').trim()
  const bare = v.replace(/^\s*(选项)?\s*([A-Da-d])\s*$/, '$2')
  const list = accepted(q)

  if (q.type === 'single' && Array.isArray(q.options)) {
    const letter = bare.toUpperCase()
    if (/^[A-D]$/.test(letter)) {
      const chosen = q.options['ABCD'.indexOf(letter)]
      return list.some((a) => looseEqual(chosen, a))
    }
    const stripped = stripChoiceLabel(v)
    if (list.some((a) => looseEqual(stripped, a))) return true
    // 盲审把选项文字抄回来了，也要认
    return q.options.some((o) => looseEqual(o, stripped) && list.some((a) => looseEqual(o, a)))
  }
  const stripped = stripChoiceLabel(v)
  return list.some((a) => looseEqual(stripped, a))
}

async function ask(messages, temperature) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, temperature, response_format: { type: 'json_object' }, messages })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return {
    json: JSON.parse(data.choices?.[0]?.message?.content ?? '{}'),
    tokens: (data.usage?.prompt_tokens || 0) + (data.usage?.completion_tokens || 0)
  }
}

const AUDIT_SYSTEM = `你是一位严谨的高中数学老师在批改作业。
你要独立把题重做一遍，不要相信题目给的答案。
只输出 JSON。如果你觉得题目本身有问题（条件不足、选项有误、多解），把 problem 置为 true 并说明。`

function auditPrompt(q) {
  const opt = q.type === 'single' ? `\n选项：\n${q.options.map((o, i) => `${'ABCD'[i]}. ${o}`).join('\n')}` : ''
  const what =
    q.type === 'judge'
      ? '判断这个命题真假，answer 输出 "true" 或 "false"'
      : q.type === 'single'
        ? '写出正确选项的内容（原样抄写该选项文字）'
        : '写出填空答案'
  return `题目：${q.stem}${opt}

${what}。
输出：{"answer":"...","problem":false,"note":""}`
}

;(async () => {
  const bank = JSON.parse(fs.readFileSync(QFILE, 'utf8'))
  const qs = bank.questions
  const sampleIdx = process.argv.indexOf('--sample')
  const list = sampleIdx >= 0 ? qs.slice(0, Number(process.argv[sampleIdx + 1])) : qs

  console.log(`盲审 ${list.length} 道题…\n`)
  const bad = []
  const unknown = []
  let ok = 0
  let tokens = 0

  for (let i = 0; i < list.length; i++) {
    const q = list[i]
    let v = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await ask(
          [
            { role: 'system', content: AUDIT_SYSTEM },
            { role: 'user', content: auditPrompt(q) }
          ],
          attempt === 1 ? 0 : 0.3
        )
        tokens += r.tokens
        v = r.json
        break
      } catch {
        await new Promise((z) => setTimeout(z, 400 * attempt))
      }
    }

    if (!v) {
      // 调用失败是工具的问题，不是题的问题——保留这道题，只做标记
      unknown.push({ id: q.id, why: '盲审调用失败（未判定）', stem: q.stem })
      process.stdout.write(`… ${q.id} 调用失败，未判定\n`)
      continue
    }
    if (v.problem) {
      bad.push({ id: q.id, why: `题目本身有问题：${v.note || ''}`, stem: q.stem, declared: q.answer })
      process.stdout.write(`? ${q.id} 题目有问题\n`)
      continue
    }
    if (verdictAgrees(q, v.answer)) {
      ok++
    } else {
      bad.push({ id: q.id, why: `答案不一致：题库=${JSON.stringify(q.answer)} 盲审=${v.answer}`, stem: q.stem, declared: q.answer })
      process.stdout.write(`✗ ${q.id} ${String(q.stem).slice(0, 30)}…  题库「${JSON.stringify(q.answer)}」盲审「${v.answer}」\n`)
    }
    if ((i + 1) % 20 === 0) process.stdout.write(`  …${i + 1}/${list.length}\n`)
  }

  console.log('\n================ 审计结果 ================')
  console.log(`通过 ${ok} · 存疑 ${bad.length} · 未判定 ${unknown.length} · 共 ${list.length} · ${tokens} tokens`)

  if (bad.length) {
    console.log('\n存疑清单：')
    bad.forEach((b) => {
      console.log(`  [${b.id}] ${b.why}`)
      console.log(`       ${String(b.stem).slice(0, 70)}`)
    })
  }

  fs.writeFileSync('.cache/audit-report.json', JSON.stringify({ ok, bad, unknown, tokens }, null, 2), 'utf8')
  console.log('\n报告：.cache/audit-report.json')

  if (process.argv.includes('--write')) {
    const badIds = new Set(bad.map((b) => b.id))
    bank.questions = qs.filter((q) => !badIds.has(q.id))
    fs.writeFileSync(QFILE, JSON.stringify(bank, null, 2), 'utf8')
    console.log(`已删除 ${badIds.size} 道存疑题，剩余 ${bank.questions.length} 道`)
  }
})()
