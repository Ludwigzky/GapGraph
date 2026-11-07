/* 验证新图谱引擎：自由布局 / 不重叠 / 可拖动 / 可增删 */
const fs = require('node:fs')
const http = require('node:http')

const P = Number(process.argv[2] || 9380)
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
    if (r && r.exceptionDetails) return 'EXC:' + JSON.stringify(r.exceptionDetails).slice(0, 200)
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
  await ev(`document.querySelector('#later')?.click()`) // 关掉自动摸底
  await sleep(500)

  console.log('=== 布局 ===')
  console.log('节点数      :', await ev(`document.querySelectorAll('#graph .node').length`))
  const geo = await ev(`(()=>{
    const nodes=[...document.querySelectorAll('#graph .node rect')].map(r=>{const b=r.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2,w:b.width,h:b.height,t:r.parentElement.textContent}});
    let overlap=0, worst=null;
    for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){
      const a=nodes[i],b=nodes[j];
      const ox=Math.min(a.x+a.w/2,b.x+b.w/2)-Math.max(a.x-a.w/2,b.x-b.w/2);
      const oy=Math.min(a.y+a.h/2,b.y+b.h/2)-Math.max(a.y-a.h/2,b.y-b.h/2);
      if(ox>1&&oy>1){overlap++; if(!worst)worst=a.t+' / '+b.t;}
    }
    const sizes=nodes.map(n=>Math.round(n.w)+'x'+Math.round(n.h));
    const uniq=[...new Set(sizes)];
    return {count:nodes.length, overlap, worst, sizeVariants:uniq.length, sample:uniq.slice(0,6).join(' ')};
  })()`)
  console.log('重叠对数    :', geo.overlap, geo.worst ? '(' + geo.worst + ')' : '')
  console.log('尺寸种类    :', geo.sizeVariants, '→', geo.sample)
  console.log('字被裁掉    :', await ev(`(()=>{
    let bad=0;
    document.querySelectorAll('#graph .node').forEach(g=>{
      const r=g.querySelector('rect'); const rb=r.getBBox();
      g.querySelectorAll('text').forEach(t=>{const tb=t.getBBox();
        if(tb.x<rb.x+1||tb.x+tb.width>rb.x+rb.width-1) bad++;});
    });
    return bad;
  })()`), '处')

  console.log('\n=== 拖动 ===')
  const before = await ev(`(()=>{const g=[...document.querySelectorAll('#graph .node')].find(x=>x.textContent.includes('定义域'));
    const b=g.querySelector('rect').getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)}})()`)
  const drag = await ev(`(()=>{
    const g=[...document.querySelectorAll('#graph .node')].find(x=>x.textContent.includes('定义域'));
    const b=g.querySelector('rect').getBoundingClientRect();
    const sx=b.left+b.width/2, sy=b.top+b.height/2;
    const opt=(x,y)=>({bubbles:true,clientX:x,clientY:y,pointerId:1,pointerType:'mouse'});
    g.dispatchEvent(new PointerEvent('pointerdown',opt(sx,sy)));
    window.dispatchEvent(new PointerEvent('pointermove',opt(sx+160,sy+90)));
    window.dispatchEvent(new PointerEvent('pointerup',opt(sx+160,sy+90)));
    return 'dragged';
  })()`)
  await sleep(700)
  const after = await ev(`(()=>{const g=[...document.querySelectorAll('#graph .node')].find(x=>x.textContent.includes('定义域'));
    const b=g.querySelector('rect').getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)}})()`)
  console.log('拖动结果    :', drag, `从 (${before.x},${before.y}) 到 (${after.x},${after.y})`)
  console.log('位移        :', Math.round(Math.hypot(after.x - before.x, after.y - before.y)), 'px')
  console.log('位置已保存  :', await ev(`(()=>{const k=Object.keys(localStorage).find(x=>x.startsWith('gapgraph.pos.'));return k?Object.keys(JSON.parse(localStorage[k])).length+' 个节点有坐标':'无'})()`))

  console.log('\n=== 增删考点 ===')
  // 选中一个节点后新增
  await ev(`(()=>{const g=[...document.querySelectorAll('#graph .node')].find(x=>x.textContent.includes('指数函数'));g.dispatchEvent(new MouseEvent('click',{bubbles:true}))})()`)
  await sleep(400)
  const beforeCount = await ev(`document.querySelectorAll('#graph .node').length`)
  await ev(`window.prompt = () => '自定义考点X'`)
  await ev(`document.querySelector('#add-node')?.click()`)
  await sleep(900)
  console.log('新增前/后   :', beforeCount, '→', await ev(`document.querySelectorAll('#graph .node').length`))
  console.log('新节点出现  :', await ev(`[...document.querySelectorAll('#graph .node')].some(x=>x.textContent.includes('自定义考点X'))`))
  console.log('已落本地    :', await ev(`(()=>{const k=Object.keys(localStorage).find(x=>x.startsWith('gapgraph.edit.'));return k?JSON.parse(localStorage[k]).added.length+' 个新增':'无'})()`))
  // 删除它
  await ev(`window.confirm = () => true`)
  await ev(`(()=>{const g=[...document.querySelectorAll('#graph .node')].find(x=>x.textContent.includes('自定义考点X'));g.dispatchEvent(new MouseEvent('click',{bubbles:true}))})()`)
  await sleep(400)
  await ev(`document.querySelector('#del-node')?.click()`)
  await sleep(900)
  console.log('删除后节点数:', await ev(`document.querySelectorAll('#graph .node').length`))
  console.log('新节点还在  :', await ev(`[...document.querySelectorAll('#graph .node')].some(x=>x.textContent.includes('自定义考点X'))`))

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot?.data) fs.writeFileSync('.cache/s_force.png', Buffer.from(shot.data, 'base64'))
  ws.close()
  process.exit(0)
})()
