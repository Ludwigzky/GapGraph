/* 验证点状节点 + 文字在旁边 + 拖动实时排斥 */
const fs = require('node:fs')
const http = require('node:http')

const P = Number(process.argv[2] || 9391)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const get = (p) =>
  new Promise((r) => {
    http
      .get({ host: '127.0.0.1', port: P, path: p, timeout: 3000 }, (res) => {
        let b = ''
        res.on('data', (c) => (b += c))
        res.on('end', () => {
          try {
            r(JSON.parse(b))
          } catch {
            r(null)
          }
        })
      })
      .on('error', () => r(null))
  })

;(async () => {
  const page = (await get('/json/list') || []).find((t) => t.type === 'page' && String(t.url).includes('3300'))
  if (!page) {
    console.log('找不到页面')
    process.exit(1)
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pend = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m.result)
      pend.delete(m.id)
    }
  }
  const send = (m, p = {}) =>
    new Promise((res) => {
      const i = ++id
      pend.set(i, res)
      ws.send(JSON.stringify({ id: i, method: m, params: p }))
    })
  await new Promise((r) => (ws.onopen = r))
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })
    if (r && r.exceptionDetails) return 'EXC:' + JSON.stringify(r.exceptionDetails).slice(0, 160)
    return r && r.result ? r.result.value : '?'
  }

  await sleep(1200)
  await ev(`localStorage.clear()`)
  await ev(`location.hash=''; location.reload()`)
  await sleep(2200)
  await ev(`document.querySelector('#gok')?.click()`)
  await sleep(300)
  await ev(`document.querySelector('[data-enter]')?.click()`)
  await sleep(2600)
  await ev(`document.querySelector('#later')?.click()`)
  await sleep(400)

  console.log('=== 形态 ===')
  console.log('圆点数        :', await ev(`document.querySelectorAll('#graph .node circle.dot').length`))
  console.log('文字数        :', await ev(`document.querySelectorAll('#graph .node text').length`))
  console.log('圆点半径      :', await ev(`[...new Set([...document.querySelectorAll('#graph .node circle.dot')].map(c=>c.getAttribute('r')))].join(',')`))
  console.log(
    '文字在点右侧  :',
    await ev(`(()=>{
      const g=[...document.querySelectorAll('#graph .node')][3];
      const c=g.querySelector('circle.dot').getBoundingClientRect();
      const t=g.querySelector('text').getBoundingClientRect();
      return t.left > c.right - 2 ? '是（间隔'+Math.round(t.left-c.right)+'px）' : '否';
    })()`)
  )

  const overlap = await ev(`(()=>{
    const rects=(sel)=>[...document.querySelectorAll(sel)].map(e=>e.getBoundingClientRect());
    const count=(rs)=>{let o=0;for(let i=0;i<rs.length;i++)for(let j=i+1;j<rs.length;j++){
      const a=rs[i],b=rs[j];
      if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1) o++;}
      return o;};
    return {labels:count(rects('#graph .node text')), dots:count(rects('#graph .node circle.dot'))};
  })()`)
  console.log('标签互相压    :', overlap.labels, '对')
  console.log('圆点互相压    :', overlap.dots, '对')

  console.log('\n=== 拖动时的实时排斥 ===')
  const names = await ev(`(()=>{
    const gs=[...document.querySelectorAll('#graph .node')];
    const target=gs.find(x=>x.textContent.includes('定义域'));
    const others=gs.filter(x=>x!==target).slice(0,6);
    window.__target=target;
    window.__others=others;
    window.__before=others.map(g=>{const r=g.getBoundingClientRect();return [r.left,r.top]});
    return others.map(g=>g.textContent.trim().slice(0,4));
  })()`)
  console.log('观察对象      :', (names || []).join(' / '))

  await ev(`(()=>{
    const g=window.__target; const b=g.getBoundingClientRect();
    const sx=b.left+b.width/2, sy=b.top+b.height/2;
    const opt=(x,y)=>({bubbles:true,clientX:x,clientY:y,pointerId:1,pointerType:'mouse'});
    g.dispatchEvent(new PointerEvent('pointerdown',opt(sx,sy)));
    window.dispatchEvent(new PointerEvent('pointermove',opt(sx+200,sy+130)));
  })()`)
  await sleep(450)

  const deltas = await ev(`(()=>{
    return window.__others.map((g,i)=>{
      const r=g.getBoundingClientRect();
      return Math.round(Math.hypot(r.left-window.__before[i][0], r.top-window.__before[i][1]));
    });
  })()`)
  console.log('拖动中邻居位移:', (deltas || []).join(', ') + ' px')

  await ev(`(() => {
    const g = window.__target; const b = g.getBoundingClientRect();
    window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientX:b.left+10,clientY:b.top+10,pointerId:1,pointerType:'mouse'}));
  })()`)
  await sleep(700)
  console.log('位置已保存    :', await ev(`(()=>{const k=Object.keys(localStorage).find(x=>x.startsWith('gapgraph.pos.'));return k?Object.keys(JSON.parse(localStorage[k])).length+' 个':'无'})()`))

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot?.data) fs.writeFileSync('.cache/s_dots.png', Buffer.from(shot.data, 'base64'))
  ws.close()
  process.exit(0)
})()
