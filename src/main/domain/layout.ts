/**
 * 图谱布局的纯函数部分：量文字、排位置、拆重叠。
 *
 * 为什么单独拿出来：这三个东西全靠数值，最容易出错，也最该被测试钉住。
 * 图形渲染那边只负责把算好的坐标画出来。
 */

export type Vec = { x: number; y: number }

/** 字宽估算：中日韩字符按全宽算，ASCII 按 0.55 宽 */
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/

export function charWidth(ch: string, font: number): number {
  return CJK.test(ch) ? font : font * 0.55
}

export function textWidth(s: string, font: number): number {
  let w = 0
  for (const ch of s) w += charWidth(ch, font)
  return w
}

export interface LabelMetrics {
  lines: string[]
  width: number
  height: number
  /** 节点框（含内边距） */
  boxW: number
  boxH: number
  truncated: boolean
}

export interface MeasureOpts {
  font?: number
  lineHeight?: number
  maxWidth?: number
  maxLines?: number
  padX?: number
  padY?: number
  minW?: number
  minH?: number
}

/**
 * 按宽度折行 + 量出节点框。
 * 关键约束：**框一定装得下字**，装不下就截断并加省略号，
 * 绝不出现"字被节点裁掉"的情况。
 */
export function measureLabel(name: string, opts: MeasureOpts = {}): LabelMetrics {
  const font = opts.font ?? 12.5
  const lineHeight = opts.lineHeight ?? Math.round(font * 1.35)
  const maxWidth = opts.maxWidth ?? font * 7
  const maxLines = opts.maxLines ?? 3
  const padX = opts.padX ?? 10
  const padY = opts.padY ?? 7
  const minW = opts.minW ?? 44
  const minH = opts.minH ?? 30

  const rawChars = [...String(name ?? '').trim()]
  const chars = rawChars.length ? rawChars : ['?']

  const lines: string[] = []
  let cur = ''
  let truncated = false

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    const next = cur + ch
    if (textWidth(next, font) <= maxWidth || cur === '') {
      cur = next
      continue
    }
    lines.push(cur)
    cur = ch
    if (lines.length === maxLines) {
      truncated = true
      break
    }
  }
  if (!truncated && cur) lines.push(cur)
  if (lines.length > maxLines) {
    lines.length = maxLines
    truncated = true
  }
  if (truncated) {
    // 最后一行留一个位置放省略号
    const last = lines[maxLines - 1]
    let keep = last
    while (keep.length > 1 && textWidth(keep + '…', font) > maxWidth) keep = keep.slice(0, -1)
    lines[maxLines - 1] = keep + '…'
  }

  const width = Math.max(...lines.map((l) => textWidth(l, font)), 0)
  const height = lines.length * lineHeight
  return {
    lines,
    width,
    height,
    boxW: Math.max(minW, Math.ceil(width + padX * 2)),
    boxH: Math.max(minH, Math.ceil(height + padY * 2)),
    truncated
  }
}

export interface Box {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/** 两个矩形在某个轴上的重叠量（负数表示分开） */
function overlap1d(aMin: number, aMax: number, bMin: number, bMax: number): number {
  return Math.min(aMax, bMax) - Math.max(aMin, bMin)
}

/**
 * 把重叠的节点推开（AABB 分离）。
 * 每次取"重叠更少的那个轴"推，位移最小、视觉最自然。
 * 返回是否还有重叠。
 */
export function separateBoxes(
  boxes: Box[],
  gap = 14,
  iterations = 40,
  bounds?: { w: number; h: number },
  stiffness = 1
): boolean {
  let moved = false
  for (let it = 0; it < iterations; it++) {
    let any = false
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        const ox = overlap1d(a.x - a.w / 2, a.x + a.w / 2, b.x - b.w / 2, b.x + b.w / 2) + gap
        const oy = overlap1d(a.y - a.h / 2, a.y + a.h / 2, b.y - b.h / 2, b.y + b.h / 2) + gap
        if (ox <= 0 || oy <= 0) continue
        any = true
        moved = true
        // stiffness < 1 时只推一部分：连续动画里这样才像"排斥"，
        // 一次推满会变成瞬移，手感很跳。
        const k = Math.max(0.05, Math.min(1, stiffness))
        if (ox < oy) {
          const push = (ox / 2) * k * (a.x <= b.x ? -1 : 1)
          a.x += push
          b.x -= push
        } else {
          const push = (oy / 2) * k * (a.y <= b.y ? -1 : 1)
          a.y += push
          b.y -= push
        }
        if (bounds) {
          a.x = Math.max(a.w / 2, Math.min(bounds.w - a.w / 2, a.x))
          a.y = Math.max(a.h / 2, Math.min(bounds.h - a.h / 2, a.y))
          b.x = Math.max(b.w / 2, Math.min(bounds.w - b.w / 2, b.x))
          b.y = Math.max(b.h / 2, Math.min(bounds.h - b.h / 2, b.y))
        }
      }
    }
    if (!any) break
  }
  return moved
}

/** 快速判断是否还有重叠（动画循环用它决定要不要继续跑） */
export function hasOverlap(boxes: Box[], gap = 0): boolean {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      const ox = overlap1d(a.x - a.w / 2, a.x + a.w / 2, b.x - b.w / 2, b.x + b.w / 2) + gap
      const oy = overlap1d(a.y - a.h / 2, a.y + a.h / 2, b.y - b.h / 2, b.y + b.h / 2) + gap
      if (ox > 0 && oy > 0) return true
    }
  }
  return false
}

export interface ForceNode extends Box {
  pinned?: boolean
  vx: number
  vy: number
}

export interface ForceEdge {
  a: string
  b: string
  /** 结构边给弱弹簧，前置/易混边给强一点的弹簧，让相关的东西靠得近 */
  strength?: number
}

/**
 * 一步力导向：
 *  - 所有节点互相排斥（避免挤成一团）
 *  - 有边的互相吸引（相关的靠近）
 *  - 轻微向心力（别飘走）
 *  - 用户拖过的节点固定不动
 */
export interface ForceOpts {
  w: number
  h: number
  /** 温度：1 = 刚开始剧烈，接近 0 = 冷却静止。拖动时重新加热 */
  alpha?: number
  /** 节点间斥力，负值表示互相推开（d3 里叫 charge） */
  charge?: number
  /** 相连节点想保持的距离 */
  linkDistance?: number
  /** 相连节点的弹簧强度 0..1 */
  linkStrength?: number
  /** 向心力：所有节点被拉向画布中心 */
  centerStrength?: number
  /** 速度衰减 0..1，越大越"黏" */
  velocityDecay?: number
  /** 单帧位移上限，防止瞬移 */
  maxStep?: number
}

/**
 * 一步力导向，按 d3-force 的那套语义（Obsidian 关系图也是这个模型）：
 *
 *   ① 斥力   F = charge / d²        —— 像一堆正电荷互相推开
 *   ② 弹簧   F = (d − 距离) / d     —— 相连的节点被一根有静止长度的绳子拉着
 *   ③ 向心   F = (中心 − p)         —— 整体像在一个引力井里
 *   ④ 积分   v *= 衰减;  p += v
 *
 * 关键区别：**弹簧是"保持距离"，不是"越远越用力"**。
 * 之前写成 d²/k 会越拉越猛，长边一架就把整张图搅乱。
 */
export function forceStep(nodes: ForceNode[], edges: ForceEdge[], opts: ForceOpts): void {
  const w = opts.w
  const h = opts.h
  const n = nodes.length
  if (n === 0) return

  const alpha = Math.max(0, Math.min(1, opts.alpha ?? 1))
  const charge = opts.charge ?? -120
  const linkDistance = opts.linkDistance ?? 120
  const linkStrength = opts.linkStrength ?? 0.54
  const centerStrength = opts.centerStrength ?? 0.05
  const velocityDecay = Math.max(0, Math.min(0.95, opts.velocityDecay ?? 0.45))
  const maxStep = opts.maxStep ?? 60
  const cx = w / 2
  const cy = h / 2

  const byId = new Map(nodes.map((x) => [x.id, x]))

  // ① 斥力
  for (let i = 0; i < n; i++) {
    const a = nodes[i]
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let d2 = dx * dx + dy * dy
      if (d2 < 1e-4) {
        // 完全重合：给一个确定性的抖动方向，避免除零和随机抖动
        dx = (i % 2 === 0 ? 1 : -1) * 0.7
        dy = (j % 2 === 0 ? 1 : -1) * 0.9
        d2 = dx * dx + dy * dy
      }
      // d3: w = charge * alpha / d²，位移 = d 向量 × w，等效强度 ∝ 1/d
      const k = (charge * alpha) / d2
      a.vx += dx * k
      a.vy += dy * k
      b.vx -= dx * k
      b.vy -= dy * k
    }
  }

  // ② 弹簧：拉向"静止长度"，不是越远越猛
  for (const e of edges) {
    const a = byId.get(e.a)
    const b = byId.get(e.b)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.hypot(dx, dy) || 1
    const strength = (e.strength ?? 1) * linkStrength * alpha
    const l = ((d - linkDistance) / d) * strength
    a.vx += dx * l
    a.vy += dy * l
    b.vx -= dx * l
    b.vy -= dy * l
  }

  // ③ 向心 + ④ 积分
  for (const nd of nodes) {
    nd.vx += (cx - nd.x) * centerStrength * alpha
    nd.vy += (cy - nd.y) * centerStrength * alpha
    if (nd.pinned) {
      nd.vx = 0
      nd.vy = 0
      continue
    }
    nd.vx *= 1 - velocityDecay
    nd.vy *= 1 - velocityDecay
    nd.x += Math.max(-maxStep, Math.min(maxStep, nd.vx))
    nd.y += Math.max(-maxStep, Math.min(maxStep, nd.vy))
    nd.x = Math.max(nd.w / 2, Math.min(w - nd.w / 2, nd.x))
    nd.y = Math.max(nd.h / 2, Math.min(h - nd.h / 2, nd.y))
  }
}
