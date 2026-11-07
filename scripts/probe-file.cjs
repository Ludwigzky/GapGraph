/* 探测 file:// 下的 localStorage 可用性 + 走一次真实交互看数据是否落盘 */
const fs = require('node:fs')
const http = require('node:http')

const CDP = Number(process.argv[2] || 9310)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const getJson = (path) =>
  new Promise((resolve) => {
    http
      .get({ host: '127.0.0.1', port: CDP, path, timeout: 3000 }, (res) => {
        let b = ''
        res.on('data', (c) => (b += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(b))
          } catch {
            resolve(null)
          }
        })
      })
      .on('error', () => resolve(null))
  })

;(async () => {
  let page = null
  for (let i = 0; i < 24 && !page; i++) {
    await sleep(500)
    const list = await getJson('/json/list')
    page = (list || []).find((t) => t.type === 'page' && String(t.url).startsWith('file:')) || null
  }
  if (!page) {
    console.log('找不到 file:// 页面')
    process.exit(1)
  }

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

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r && r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 120)
    return r && r.result ? r.result.value : undefined
  }

  await sleep(1200)
  console.log('存储可用性 :', await ev(`(()=>{try{localStorage.setItem('__probe','1');const v=localStorage.getItem('__probe');localStorage.removeItem('__probe');return 'ok:'+v}catch(e){return 'ERR:'+e.name}})()`))

  // 关掉指南（如果有）
  await ev(`document.querySelector('#gok')?.click()`)
  await sleep(300)

  // 进摸底并答一题
  console.log('点摸底    :', await ev(`(()=>{const b=document.querySelector('#diag-start')||document.querySelector('#diag');if(!b)return 'no-btn';b.click();return 'ok'})()`))
  await sleep(600)
  console.log('点选项    :', await ev(`(()=>{const b=document.querySelector('[data-opt="0"]');if(!b)return 'no-opt';b.click();return 'ok'})()`))
  await sleep(200)
  console.log('点提交    :', await ev(`(()=>{const b=document.querySelector('#submit');if(!b)return 'no-submit';b.click();return 'ok'})()`))
  await sleep(700)
  console.log('错因按钮  :', JSON.stringify(await ev(`[...document.querySelectorAll('[data-reason]')].map(b=>b.textContent.trim())`)))
  console.log('点"概念不清":', await ev(`(()=>{const b=[...document.querySelectorAll('[data-reason]')].find(x=>x.textContent.includes('概念不清'));if(!b)return 'no';b.click();return 'ok'})()`))
  await sleep(900)

  console.log('已测数量  :', await ev(`document.querySelector('#coverage')?.textContent`))
  console.log('落盘状态  :', await ev(`(()=>{try{const raw=localStorage.getItem('gapgraph.state.v1');if(!raw)return 'NO-DATA';const s=JSON.parse(raw);return 'attempts='+s.attempts.length+' 错因='+(s.attempts[0]?.errorReason||'无')}catch(e){return 'ERR:'+e.name}})()`))

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot?.data) fs.writeFileSync('.cache/s_file_after.png', Buffer.from(shot.data, 'base64'))
  ws.close()
  process.exit(0)
})()
