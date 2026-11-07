/* 探路：用本机已有的 DEEPSEEK_API_KEY 真打一次结构化请求，测延迟/格式/成本。不打印密钥。 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
if (!fs.existsSync(file)) {
  console.log('未找到凭据文件')
  process.exit(1)
}
const raw = fs.readFileSync(file, 'utf8')

// 抓 DEEPSEEK_API_KEY 附近形如 sk-xxxx 的值
const m = raw.match(/DEEPSEEK_API_KEY[\s\S]{0,200}?(sk-[A-Za-z0-9_\-]{10,})/) || raw.match(/(sk-[A-Za-z0-9_\-]{20,})/)
if (!m) {
  console.log('凭据文件里没找到形如 sk- 的 key')
  process.exit(1)
}
const key = m[1]
console.log('key 读取成功，长度 =', key.length, '前缀 =', key.slice(0, 5) + '***')

const SYSTEM = '你是一位高考数学老师。只输出 JSON，不要任何额外文字。'

async function probe(model, label) {
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `考点：指数函数与对数函数比较大小（高考数学）。
学生问：为什么这里要取对数？
请严格按此 JSON 结构回答：
{"answer":"不超过120字的结论加一句为什么","cards":[{"type":"conclusion|method|pitfall|formula","front":"正面问题","back":"背面答案"}],"confused_with":[],"needs_more_context":false}`
      }
    ],
    temperature: 0.3,
    response_format: { type: 'json_object' }
  }

  const t0 = Date.now()
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body)
    })
    const ms = Date.now() - t0
    const text = await res.text()
    if (!res.ok) {
      console.log(`[${label}] HTTP ${res.status} (${ms}ms)`, text.slice(0, 200))
      return
    }
    const data = JSON.parse(text)
    const content = data.choices?.[0]?.message?.content ?? ''
    let parsed = null
    try {
      parsed = JSON.parse(content)
    } catch {
      /* 非 JSON */
    }
    console.log(`[${label}] ${ms}ms · tokens in=${data.usage?.prompt_tokens} out=${data.usage?.completion_tokens}`)
    console.log('  JSON 可解析:', !!parsed, '| 字段:', parsed ? Object.keys(parsed).join(',') : '(不是 JSON)')
    if (parsed) {
      console.log('  卡片数:', Array.isArray(parsed.cards) ? parsed.cards.length : '无')
      console.log('  answer 字数:', (parsed.answer || '').length)
      console.log('  样例:', String(parsed.answer).slice(0, 60) + '…')
    }
  } catch (e) {
    console.log(`[${label}] 请求失败 (${Date.now() - t0}ms):`, e.message)
  }
}

;(async () => {
  await probe('deepseek-chat', 'deepseek-chat')
})()
