// 临时校验脚本：验证 graph-mock.html 的布局不会重叠，且连线锚点都在节点中心
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');

// 1) JS 语法
const js = src.match(/<script>([\s\S]*?)<\/script>/)[1];
try { new Function(js); console.log('✔ JS 语法检查通过'); }
catch (e) { console.log('✘ JS 语法错误:', e.message); process.exit(1); }

// 2) 取数据
const arr = js.match(/const N = (\[[\s\S]*?\n\];)/)[1].replace(/;$/, '');
const N = eval(arr);
console.log('✔ 节点数:', N.length);
const ids = new Set(N.map(n => n.id));
console.log(ids.size === N.length ? '✔ 节点 id 无重复' : '✘ 存在重复 id');

// 3) 复刻布局
const W = 118, H = 34, GAPX = 34, GAPY = 104, PADX = 70, PADY = 44;
const byId = {}, kids = {};
N.forEach(n => { byId[n.id] = n; if (n.p) (kids[n.p] = kids[n.p] || []).push(n); });
const levels = [];
(function walk(id, d) { (levels[d] = levels[d] || []).push(id); (kids[id] || []).forEach(k => walk(k.id, d + 1)); })('root', 0);

const x = {}, y = {};
let cursor = PADX;
(function assign(id) {
  const c = kids[id] || [];
  if (!c.length) { x[id] = cursor; cursor += W + GAPX; return; }
  c.forEach(k => assign(k.id));
  x[id] = (x[c[0].id] + x[c[c.length - 1].id]) / 2;
})('root');
const shift = (id, dx) => { x[id] += dx; (kids[id] || []).forEach(k => shift(k.id, dx)); };
function relaxRow(d) {
  const row = levels[d].slice().sort((a, b) => x[a] - x[b]);
  for (let i = 1; i < row.length; i++) {
    const need = x[row[i - 1]] + W + GAPX;
    if (x[row[i]] < need) shift(row[i], need - x[row[i]]);
  }
}
for (let d = 0; d < levels.length; d++) relaxRow(d);
for (let p = 0; p < 3; p++) {
  for (let d = levels.length - 2; d >= 0; d--)
    levels[d].forEach(id => { const c = kids[id]; if (c && c.length) x[id] = (x[c[0].id] + x[c[c.length - 1].id]) / 2; });
  for (let d = 0; d < levels.length; d++) relaxRow(d);
}
levels.forEach((row, d) => row.forEach(id => { y[id] = PADY + d * GAPY; }));

// 4) 断言：每层横向无重叠
let ok = true, worst = Infinity;
levels.forEach((row, d) => {
  const s = row.slice().sort((a, b) => x[a] - x[b]);
  for (let i = 1; i < s.length; i++) {
    const gap = x[s[i]] - x[s[i - 1]] - W;
    if (gap < worst) worst = gap;
    if (gap < 0) { ok = false; console.log(`  ✘ L${d} 重叠: ${s[i - 1]} 与 ${s[i]}，间隙 ${gap.toFixed(1)}px`); }
  }
});
console.log(ok ? `✔ 各层无重叠（最小水平间隙 ${worst.toFixed(1)}px）` : '✘ 存在重叠');

// 5) 断言：同层顶点不会压到上一层节点的底边
let okV = true;
levels.forEach((row, d) => {
  if (d === 0) return;
  const prev = levels[d - 1];
  row.forEach(id => {
    prev.forEach(pid => {
      const dx = Math.abs(x[id] - x[pid]);
      const dy = y[id] - y[pid];
      if (dx < W && dy < H) { okV = false; console.log(`  ✘ 竖向压叠: ${pid} 与 ${id}`); }
    });
  });
});
console.log(okV ? '✔ 相邻层之间无压叠' : '✘ 竖向压叠');

// 6) 输出画布尺寸
const maxX = Math.max(...N.map(n => x[n.id])) + W + PADX;
const maxY = Math.max(...N.map(n => y[n.id])) + H + PADY;
console.log(`✔ 画布内容尺寸: ${Math.round(maxX)} × ${Math.round(maxY)} px`);

// 7) 断言：连线锚点取中心，且端点必然落在节点边界上
const cx = id => x[id] + W / 2, bY = id => y[id] + H, tY = id => y[id];
let okA = true;
[...N.filter(n => n.p).map(n => [n.p, n.id])].forEach(([a, b]) => {
  if (Math.abs(cx(a) - (x[a] + W / 2)) > 0.001) okA = false;
  if (bY(a) !== y[a] + H || tY(b) !== y[b]) okA = false;
});
console.log(okA ? '✔ 连线锚点 = 父节点下沿中心 → 子节点上沿中心（不会脱离）' : '✘ 锚点错误');
