/* 验证本轮三个功能：自动摸底 / 板块融合（含跨学科拦截）/ 重命名 */
const fs = require('node:fs')
const http = require('node:http')

const P = Number(process.argv[2] || 9370)
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

  /* ---------- 功能 1：首次进入自动弹出摸底 ---------- */
  console.log('=== 1. 自动摸底 ===')
  await ev(`document.querySelector('[data-enter]')?.click()`)
  await sleep(2600)
  console.log('页面          :', await ev(`document.body.dataset.page`))
  console.log('自动弹出摸底  :', await ev(`document.querySelector('#modal')?.classList.contains('open')`))
  console.log('弹窗标题      :', await ev(`document.querySelector('#modal .qhead')?.textContent?.trim().slice(0,24)||'(无)'`))
  console.log('有退出入口    :', await ev(`!!document.querySelector('#later')`))
  await ev(`document.querySelector('#later')?.click()`)
  await sleep(600)
  console.log('退出后弹窗关闭:', await ev(`!(document.querySelector('#modal')?.classList.contains('open'))`))
  console.log('再次进入不重复:', await ev(`(()=>{const k=Object.keys(localStorage).filter(x=>x.startsWith('gapgraph.diag.auto.'));return k.length+' 个标记'})()`))

  /* ---------- 注入测试板块 ---------- */
  await ev(`(()=>{
    const mk=(id,exam,subject,chapter,extra)=>{
      const nodes=[{id:'r',name:chapter,parentId:null,kind:'root',examWeight:1,prereq:[],confusable:[],brief:''}];
      (extra||['概念A','概念B']).forEach((n,i)=>nodes.push({id:'n'+(i+1),name:n,parentId:'r',kind:'concept',examWeight:0.8,prereq:[],confusable:[],brief:''}));
      return {packId:id,title:chapter,subject,totalScore:150,source:'测试',meta:{exam,subject,chapter},nodes,relations:[]};
    };
    const all={
      'chem-ene': mk('chem-ene','高考','化学','烯烃',['加成反应','碳碳双键']),
      'chem-ane': mk('chem-ane','高考','化学','烷烃',['取代反应','同分异构']),
      'math-fn':  mk('math-fn','高考','数学','函数',['定义域','单调性'])
    };
    localStorage.setItem('gapgraph.packs.v1',JSON.stringify(all));
    // 给两个化学板块各塞两道题，验证融合后题目也合并
    const q=(id,stem)=>({id,type:'single',difficulty:2,stem,options:['甲','乙','丙','丁'],answer:'甲',solution:'略',tags:[{nodeId:'n1',weight:1,primary:true}]});
    localStorage.setItem('gapgraph.qbank.chem-ene.v1',JSON.stringify([q('q1','烯烃题一'),q('q2','烯烃题二')]));
    localStorage.setItem('gapgraph.qbank.chem-ane.v1',JSON.stringify([q('q1','烷烃题一')]));
    localStorage.setItem('gapgraph.state.chem-ene.v1',JSON.stringify({settings:{dailyMinutes:40,examDate:'2027-06-07',totalScore:150,packId:'chem-ene'},mastery:{r:{K:1,A:1,s:10,n:0,misconception:0,lastAt:0,prior:1},n1:{K:1,A:0.8,s:5,n:3,misconception:0,lastAt:Date.now(),prior:1}},attempts:[],tasks:[]}));
  })()`)
  await ev(`location.hash=''; location.reload()`)
  await sleep(2200)
  await ev(`document.querySelector('#gok')?.click()`)
  await sleep(400)

  console.log('\n=== 3. 重命名 ===')
  console.log('板块卡片数    :', await ev(`document.querySelectorAll('.pcard').length`))
  await ev(`(()=>{const b=[...document.querySelectorAll('[data-rename]')].find(x=>x.dataset.rename==='chem-ene');b.click()})()`)
  await sleep(400)
  console.log('改名浮层打开  :', await ev(`document.querySelector('#cards')?.classList.contains('open')`))
  await ev(`(()=>{const i=document.querySelector('#rn-input');i.value='烯烃（改名验证）';return i.value})()`)
  await ev(`document.querySelector('#rn-save')?.click()`)
  await sleep(600)
  const titles = await ev(`[...document.querySelectorAll('.ptitle')].map(x=>x.textContent.trim()).join(' | ')`)
  console.log('改名后标题    :', titles)

  console.log('\n=== 2. 板块融合 ===')
  // 选两个化学
  await ev(`(()=>{[...document.querySelectorAll('[data-pick]')].filter(b=>['chem-ene','chem-ane'].includes(b.dataset.pick)).forEach(b=>b.click())})()`)
  await sleep(400)
  console.log('融合区出现    :', await ev(`!!document.querySelector('.mergebox')`))
  console.log('同学科提示    :', await ev(`document.querySelector('.mergeinfo .okline')?.textContent||'(无)'`))
  console.log('融合按钮可用  :', await ev(`!(document.querySelector('#merge-go')?.disabled)`))
  await ev(`(()=>{const i=document.querySelector('#merge-name');i.value='烃类化合物';return 1})()`)
  await ev(`document.querySelector('#merge-go')?.click()`)
  await sleep(2600)
  console.log('融合后进入    :', await ev(`document.body.dataset.page`))
  console.log('融合板块名    :', await ev(`document.querySelector('.node-name')?.textContent||(document.querySelector('#panel .node-name')?.textContent)||'(见图谱)'`))
  console.log('图谱节点数    :', await ev(`document.querySelectorAll('#graph .node').length`))
  const merged = await ev(`(()=>{
    const all=JSON.parse(localStorage.getItem('gapgraph.packs.v1')||'{}');
    const k=Object.keys(all).find(x=>x.startsWith('merge-'));
    if(!k)return '无融合板块';
    const p=all[k];
    const qb=JSON.parse(localStorage.getItem('gapgraph.qbank.'+k+'.v1')||'[]');
    return '节点'+p.nodes.length+' 题'+qb.length+' 学科'+p.meta.exam+'/'+p.meta.subject+' 名「'+p.meta.chapter+'」';
  })()`)
  console.log('融合结果      :', merged)

  /* ---------- 跨学科拦截 ---------- */
  await ev(`location.hash=''; location.reload()`)
  await sleep(2200)
  await ev(`document.querySelector('#gok')?.click()`)
  await sleep(300)
  await ev(`(()=>{[...document.querySelectorAll('[data-pick]')].filter(b=>['math-fn','chem-ane'].includes(b.dataset.pick)).forEach(b=>b.click())})()`)
  await sleep(400)
  console.log('\n跨学科提示    :', await ev(`document.querySelector('.mergeinfo .badline')?.textContent||'(无拦截)'`))
  console.log('融合按钮禁用  :', await ev(`document.querySelector('#merge-go')?.disabled`))

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot?.data) fs.writeFileSync('.cache/s_merge.png', Buffer.from(shot.data, 'base64'))
  ws.close()
  process.exit(0)
})()
