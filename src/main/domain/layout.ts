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
  /** 硬钉住：物理完全不动（只给根节点这种锚点用） */
  pinned?: boolean
  /** 软锚：用户拖过的位置，用弱弹簧往回拉，但仍然会被邻居挤动 */
  anchor?: { x: number; y: number }
  /** 上一帧的位移，用来识别"来回震" */
  pdx?: number
  pdy?: number
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
  /**
   * 向心：只把"整体重心"平移回画布中心，**不对单个节点施加随距离增长的拉力**。
   * 之前写成 k·r 会让边缘节点被拉回来的力远大于斥力（实测 125 倍），
   * 结果是外围往内收拢、整张图缩成一坨，而不是从中心发散出去。
   */
  recenter?: number
  /**
   * 软锚强度：用户拖过的位置用弱弹簧往回拉。
   * 设成 0 就完全不留恋；设成 1 等于钉死。
   * 关键是"弱"——强到能让它留在原地，弱到邻居还能把它挤开一点。
   */
  anchorStrength?: number
  /**
   * 斥力的最小距离钳制。两节点挨得很近时 1/d² 会爆掉，
   * 和分离器互相顶，表现为高频震动。钳住之后近距离不再加码，交给分离器处理。
   */
  minDistance?: number
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
  const recenter = opts.recenter ?? 0.08
  const anchorStrength = opts.anchorStrength ?? 0.15
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
      // 但距离太近时 1/d² 会爆，和分离器对着干 -> 震动，所以钳一个下限
      const minD = opts.minDistance ?? 50
      const dd = Math.max(d2, minD * minD)
      const k = (charge * alpha) / dd
      a.vx += dx * k
      a.vy += dy * k
      b.vx -= dx * k
      b.vy -= dy * k

      // 力被钳住之后，贴得太近的两个点靠力是分不开的（1/d² 被压平了），
      // 所以近距离额外做一次小幅位置分离——不产生速度，就不会来回震。
      // 注意：dx = b − a，所以 a 要往 −dx 方向让、b 往 +dx 方向让。
      if (d2 < minD * minD) {
        const d = Math.sqrt(d2) || 1
        const push = (minD - d) * 0.06 * alpha
        const ux = dx / d
        const uy = dy / d
        if (!a.pinned) {
          a.x -= ux * push
          a.y -= uy * push
        }
        if (!b.pinned) {
          b.x += ux * push
          b.y += uy * push
        }
      }
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

  // ③ 向心：只平移整体重心，不改形状（d3 的 forceCenter 就是这么做的）。
  //    节点不再受"离得越远拉得越狠"的力，外围才能自由发散。
  if (recenter > 0) {
    let sx = 0
    let sy = 0
    let cnt = 0
    for (const nd of nodes) {
      if (nd.pinned) continue
      sx += nd.x
      sy += nd.y
      cnt++
    }
    if (cnt > 0) {
      const shiftX = (cx - sx / cnt) * recenter
      const shiftY = (cy - sy / cnt) * recenter
      for (const nd of nodes) {
        if (nd.pinned) continue
        nd.x += shiftX
        nd.y += shiftY
      }
    }
  }

  // ④ 积分
  for (const nd of nodes) {
    if (nd.pinned) {
      nd.vx = 0
      nd.vy = 0
      continue
    }
    // 软锚：把用户摆过的位置当一根很松的皮筋，不是钉子
    if (nd.anchor) {
      nd.vx += (nd.anchor.x - nd.x) * anchorStrength * alpha
      nd.vy += (nd.anchor.y - nd.y) * anchorStrength * alpha
    }
    nd.vx *= 1 - velocityDecay
    nd.vy *= 1 - velocityDecay
    // 反抖：如果这一帧要往"上一帧的反方向"走，说明在来回震，砍掉一半速度
    if (nd.pdx !== undefined && nd.pdy !== undefined && (nd.pdx !== 0 || nd.pdy !== 0)) {
      if (nd.vx * nd.pdx + nd.vy * nd.pdy < 0) {
        nd.vx *= 0.5
        nd.vy *= 0.5
      }
    }
    const stepX = Math.max(-maxStep, Math.min(maxStep, nd.vx))
    const stepY = Math.max(-maxStep, Math.min(maxStep, nd.vy))
    nd.pdx = stepX
    nd.pdy = stepY
    nd.x += stepX
    nd.y += stepY
    nd.x = Math.max(nd.w / 2, Math.min(w - nd.w / 2, nd.x))
    nd.y = Math.max(nd.h / 2, Math.min(h - nd.h / 2, nd.y))
  }
}
