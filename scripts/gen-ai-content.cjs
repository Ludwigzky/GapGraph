/**
 * 预生成 AI 讲解与卡片。
 *
 * 为什么预生成而不是运行时调用：
 *   1. 浏览器/file:// 版本受 CORS 限制，根本调不了 api.deepseek.com
 *   2. 现场演示等 AI 吐字 = 翻车风险
 *   3. 42 个考点跑一遍成本约 ¥0.05，一次性投入换永久零延迟
 *
 * 用法：node scripts/gen-ai-content.cjs
 * 产物：resources/ai/gaokao-math-function.json
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PROMPT_VERSION = 'v1'
const MODEL = 'deepseek-chat'

const credFile = path.join(os.homedir(), '.dsh', '.credentials.yaml')
const raw = fs.readFileSync(credFile, 'utf8')
const found = raw.match(/DEEPSEEK_API_KEY[\s\S]{0,200}?(sk-[A-Za-z0-9_\-]{10,})/) || raw.match(/(sk-[A-Za-z0-9_\-]{20,})/)
if (!found) {
  console.error('未找到 API key')
  process.exit(1)
}
const KEY = found[1]

const pack = JSON.parse(fs.readFileSync('resources/packs/gaokao-math-function.json', 'utf8'))
const outFile = 'resources/ai/gaokao-math-function.json'

const SYSTEM =
  '你是高考数学老师，面向高三学生。只输出 JSON，不要 markdown、不要任何解释性文字。'

function userPrompt(node) {
  return `考点：${node.name}（属于高考数学「函数」板块）
现有简述：${node.brief || '（无）'}
考频权重：${node.examWeight}

请输出：
{
  "explain": "120 字以内。这个考点是什么、高考怎么考、最容易错在哪，三句话说完，不要客套。",
  "cards": [ 1 到 2 张，每张能独立复习 ]
}
每张卡的格式：{"type":"conclusion|method|pitfall|formula","front":"正面提问","back":"背面答案，40字以内"}`
}

async function callOne(node) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt(node) }
    ],
    temperature: 0.4,
    response_format: { type: 'json_object' }
  }
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content ?? '{}'
  const parsed = JSON.parse(content)
  const cards = (Array.isArray(parsed.cards) ? parsed.cards : []).slice(0, 2).map((c) => ({
    type: ['conclusion', 'method', 'pitfall', 'formula'].includes(c.type) ? c.type : 'conclusion',
    front: String(c.front || '').slice(0, 60),
    back: String(c.back || '').slice(0, 80)
  }))
  return {
    explain: String(parsed.explain || '').slice(0, 260),
    cards,
    usage: data.usage || {}
  }
}

;(async () => {
  const nodes = pack.nodes.filter((n) => n.kind !== 'root')
  console.log(`开始生成 ${nodes.length} 个考点…`)
  const byNode = {}
  let tokens = 0
  let ok = 0
  let fail = 0

  for (const node of nodes) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await callOne(node)
        byNode[node.id] = { explain: r.explain, cards: r.cards }
        tokens += (r.usage.prompt_tokens || 0) + (r.usage.completion_tokens || 0)
        ok++
        process.stdout.write(`  ✓ ${node.name} (${r.cards.length} 卡)\n`)
        break
      } catch (e) {
        if (attempt === 2) {
          fail++
          process.stdout.write(`  ✗ ${node.name} 失败: ${e.message}\n`)
        } else {
          await new Promise((r) => setTimeout(r, 600))
        }
      }
    }
  }

  const payload = {
    packId: pack.packId,
    promptVersion: PROMPT_VERSION,
    model: MODEL,
    generatedAt: new Date().toISOString(),
    tokens,
    byNode
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8')

  console.log(`\n完成：成功 ${ok}，失败 ${fail}，共 ${tokens} tokens`)
  console.log('产物：', outFile, (fs.statSync(outFile).size / 1024).toFixed(1) + ' KB')
})()
