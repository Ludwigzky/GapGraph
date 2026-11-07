/* 用 CDP 驱动一次真实操作：进摸底 → 选错 → 看是否出现错因按钮 → 截图 */
const fs = require('node:fs')
const http = require('node:http')

const CDP = Number(process.argv[3] || 9301)
const OUT = process.argv[2] || '.cache/s_reason.png'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const getJson = (path) =>
  new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: CDP, path, timeout: 3000 }, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => resolve(JSON.parse(b)))
    }).on('error', () => resolve(null))
  })

;(async () => {
  let page = null
  for (let i = 0; i < 24 && !page; i++) {
    await sleep(500)
    const list = await getJson('/json/list')
    const pages = (list || []).filter((t) => t.type === 'page')
    page = pages.find((t) => String(t.url).includes('127.0.0.1')) || null
  }
  if (!page) {
    console.log('找不到应用页面 target')
    process.exit(1)
  }
  console.log('目标页面:', page.url)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result)
      pending.delete(m.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  await new Promise((r) => (ws.onopen = r))

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return r && r.result ? r.result.value : undefined
  }

  await sleep(1500)
  console.log('当前模态:', await evaluate(`document.querySelector('#modal')?.className || '(无)'`))

  // 选第一个选项（摸底第一题是"比较大小"，A 是错的）
  const picked = await evaluate(`(() => {
    const b = document.querySelector('[data-opt="0"]');
    if (!b) return 'no-option';
    b.click(); return b.textContent.trim().slice(0, 20);
  })()`)
  console.log('点选:', picked)
  await sleep(300)

  const submitted = await evaluate(`(() => {
    const b = document.querySelector('#submit');
    if (!b) return 'no-submit';
    b.click(); return 'clicked';
  })()`)
  console.log('提交:', submitted)
  await sleep(1500)

  const chips = await evaluate(`[...document.querySelectorAll('[data-reason]')].map(b => b.textContent.trim())`)
  console.log('错因按钮:', JSON.stringify(chips))

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot && shot.data) {
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
    console.log('截图已保存:', OUT)
  } else {
    console.log('截图失败')
  }
  ws.close()
  process.exit(0)
})()
