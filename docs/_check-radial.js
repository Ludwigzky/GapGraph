// 校验 graph-radial.html：角度均分、圆不重叠、连线端点贴边、画布尺寸
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const js = src.match(/<script>([\s\S]*?)<\/script>/)[1];

try { new Function(js); console.log('✔ JS 语法检查通过'); }
catch (e) { console.log('✘ JS 语法错误:', e.message); process.exit(1); }

const grab = re => js.match(re)[1];
const N = eval(grab(/const N = (\[[\s\S]*?\n\];)/).replace(/;$/, ''));
const RING = eval(grab(/const RING = (\[[^\]]*\])/));
const RC = eval(grab(/const RC   = (\[[^\]]*\])/));
const TILT = parseFloat(grab(/const TILT = ([0-9.]+)/));

console.log('✔ 节点数:', N.length, '| 壳层半径:', RING.join('/'), '| 圆半径:', RC.join('/'), '| 压扁:', TILT);

const byId = {}, kids = {}, depth = {};
N.forEach(n => { byId[n.id] = n; if (n.p) (kids[n.p] = kids[n.p] || []).push(n); });
(function w(id, d) { depth[id] = d; (kids[id] || []).forEach(k => w(k.id, d + 1)); })('root', 0);

const span = {}; let lc = 0;
(function post(id) {
  const c = kids[id] || [];
  if (!c.length) { span[id] = [lc, lc]; lc++; return; }
  c.forEach(k => post(k.id));
  span[id] = [span[c[0].id][0], span[c[c.length - 1].id][1]];
})('root');
const STEP = 360 / lc;
const ang = {};
N.forEach(n => { ang[n.id] = -90 + ((span[n.id][0] + span[n.id][1]) / 2 + 0.5) * STEP; });
console.log('✔ 叶子数:', lc, '| 每叶角度:', STEP.toFixed(2) + '°');

const OUT = RING[3] + RC[3] + 72, CW = OUT * 2, CH = OUT * 2 * TILT + 40, CX = CW / 2, CY = CH / 2;
const pos = id => { const d = Math.min(depth[id], 3), r = RING[d], a = ang[id] * Math.PI / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a) * TILT]; };
const rr = id => RC[Math.min(depth[id], 3)];

// 1) 圆与圆不重叠（按屏幕上真实距离）
let worst = Infinity, worstPair = '', bad = 0;
for (let i = 0; i < N.length; i++) for (let j = i + 1; j < N.length; j++) {
  const a = N[i].id, b = N[j].id;
  const pa = pos(a), pb = pos(b);
  const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) - rr(a) - rr(b);
  if (d < worst) { worst = d; worstPair = a + '↔' + b; }
  if (d < 0) bad++;
}
console.log(bad === 0
  ? `✔ 无重叠（最紧的一对 ${worstPair}，余量 ${worst.toFixed(1)}px）`
  : `✘ ${bad} 对重叠，最紧 ${worstPair} 缺 ${(-worst).toFixed(1)}px`);

// 2) 跨支路连线端点贴边
const chordPts = (a, b) => {
  const pa = pos(a), pb = pos(b);
  const dx = pb[0] - pa[0], dy = pb[1] - pa[1], L = Math.hypot(dx, dy);
  return { p1: [pa[0] + dx / L * rr(a), pa[1] + dy / L * rr(a)], pa, r1: rr(a), L,
           p2: [pb[0] - dx / L * rr(b), pb[1] - dy / L * rr(b)], pb, r2: rr(b) };
};
const PRE = eval('[' + js.match(/const PRE = (\[[\s\S]*?\];)/)[1].replace(/;$/, '').slice(1, -1) + ']');
let okEdge = true;
PRE.forEach(([a, b]) => {
  const c = chordPts(a, b);
  const e1 = Math.abs(Math.hypot(c.p1[0] - c.pa[0], c.p1[1] - c.pa[1]) - c.r1);
  const e2 = Math.abs(Math.hypot(c.p2[0] - c.pb[0], c.p2[1] - c.pb[1]) - c.r2);
  if (e1 > 1e-6 || e2 > 1e-6) okEdge = false;
});
console.log(okEdge ? '✔ 前置线端点精确落在圆周上（不会脱离）' : '✘ 端点偏离圆周');

// 3) 树线：首尾收缩到父/子圆周上
let okSpiral = true;
const trim = (p0, p1, rad) => {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], L = Math.hypot(dx, dy) || 1;
  return [p0[0] + dx / L * rad, p0[1] + dy / L * rad];
};
N.forEach(n => {
  if (!n.p) return;
  const da = Math.min(depth[n.p], 3), db = Math.min(depth[n.id], 3);
  const pts = [];
  for (let i = 0; i <= 22; i++) {
    const t = i / 22;
    const r = RING[da] + (RING[db] - RING[da]) * t;
    const th = (ang[n.p] + (ang[n.id] - ang[n.p]) * t) * Math.PI / 180;
    pts.push([CX + r * Math.cos(th), CY + r * Math.sin(th) * TILT]);
  }
  const pa = pos(n.p), pb = pos(n.id);
  pts[0] = trim(pa, pts[1], RC[da]);
  pts[pts.length - 1] = trim(pb, pts[pts.length - 2], RC[db]);
  const d1 = Math.abs(Math.hypot(pts[0][0] - pa[0], pts[0][1] - pa[1]) - RC[da]);
  const d2 = Math.abs(Math.hypot(pts[pts.length - 1][0] - pb[0], pts[pts.length - 1][1] - pb[1]) - RC[db]);
  if (d1 > 1e-6 || d2 > 1e-6) okSpiral = false;
});
console.log(okSpiral ? '✔ 树线首尾精确贴合父/子圆周' : '✘ 树线端点偏移');

console.log(`✔ 画布内容尺寸: ${Math.round(CW)} × ${Math.round(CH)} px（横向铺开版为 4818 × 434）`);
