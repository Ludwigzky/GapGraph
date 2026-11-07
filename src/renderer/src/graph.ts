import type { KNode, Mastery, Relation } from '../../shared/types'
import { masteryScore } from '../../shared/mastery'

const NS = 'http://www.w3.org/2000/svg'
const RING = [0, 175, 350, 510]
const RC = [32, 26, 20, 19]
const TILT = 1
const OUT = RING[3] + RC[3] + 72
const CW = OUT * 2
const CH = OUT * 2 * TILT + 40
const CX = CW / 2
const CY = CH / 2

export type GraphMode = 'structure' | 'gap'

const COLOR: Record<string, string> = {
  red: 'var(--c1)',
  orange: 'var(--c2)',
  yellow: 'var(--c3)',
  green: 'var(--c5)',
  unmeasured: 'var(--c0)'
}

function colorOf(m: Mastery | undefined, now: number): string {
  if (!m || (m.n === 0 && m.K === 0)) return COLOR.unmeasured
  const s = masteryScore(m, now)
  if (s < 0.25) return COLOR.red
  if (s < 0.4) return COLOR.orange
  if (s < 0.6) return COLOR.yellow
  return COLOR.green
}

function wrapText(name: string, per: number): string[] {
  if (name.length <= per) return [name]
  if (name.length <= per * 2) return [name.slice(0, per), name.slice(per)]
  return [name.slice(0, per), name.slice(per, per * 2 - 1) + '…']
}

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {}
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag) as unknown as SVGElementTagNameMap[K]
  for (const k in attrs) e.setAttribute(k, String(attrs[k]))
  return e
}

export class RadialGraph {
  private svg: SVGSVGElement
  private cam: SVGGElement
  private gRing: SVGGElement
  private gEdge: SVGGElement
  private gNode: SVGGElement
  private gLabel: SVGGElement
  private nodes: KNode[] = []
  /** 当前实际渲染的节点（折叠第三层时只渲染前两层） */
  private vis: KNode[] = []
  private visIds = new Set<string>()
  private fold = true
  private relations: Relation[] = []
  private mastery: Record<string, Mastery> = {}
  private now = Date.now()
  private depth = new Map<string, number>()
  private ang = new Map<string, number>()
  private k = 1
  private tx = 0
  private ty = 0
  private mode: GraphMode = 'structure'
  private selected: string | null = null
  private drag: { x: number; y: number; tx: number; ty: number } | null = null
  private onSelect: (id: string | null) => void

  constructor(svg: SVGSVGElement, onSelect: (id: string | null) => void) {
    this.svg = svg
    this.onSelect = onSelect
    this.cam = el('g')
    this.gRing = el('g')
    this.gEdge = el('g')
    this.gNode = el('g')
    this.gLabel = el('g')
    const defs = el('defs')
    defs.innerHTML =
      '<marker id="arw" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M0,0.5 L9,5 L0,9.5 z" fill="#5b6472"/></marker>'
    this.svg.append(defs, this.cam)
    // gLabel 放在最后，圆环标签永远浮在节点之上，不会被圆形节点盖住
    this.cam.append(this.gRing, this.gEdge, this.gNode, this.gLabel)

    this.svg.addEventListener('wheel', this.onWheel, { passive: false })
    this.svg.addEventListener('pointerdown', this.onDown)
    window.addEventListener('pointermove', this.onMove)
    window.addEventListener('pointerup', this.onUp)
  }

  destroy(): void {
    this.svg.removeEventListener('wheel', this.onWheel)
    this.svg.removeEventListener('pointerdown', this.onDown)
    window.removeEventListener('pointermove', this.onMove)
    window.removeEventListener('pointerup', this.onUp)
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const r = this.svg.getBoundingClientRect()
    this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0016))
  }

  private downAt: { x: number; y: number } | null = null

  private onDown = (e: PointerEvent): void => {
    if ((e.target as Element).closest('.node')) {
      this.downAt = null
      return
    }
    this.downAt = { x: e.clientX, y: e.clientY }
    this.drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty }
  }

  private onMove = (e: PointerEvent): void => {
    if (!this.drag) return
    this.tx = this.drag.tx + (e.clientX - this.drag.x)
    this.ty = this.drag.ty + (e.clientY - this.drag.y)
    this.applyCam()
  }

  private onUp = (e: PointerEvent): void => {
    // 在空白处"点一下"（不是拖动）＝取消选中，前置箭头随之收起
    if (this.downAt && this.drag) {
      const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y)
      const onNode = !!(e.target as Element)?.closest?.('.node')
      if (moved < 4 && !onNode && this.selected) this.onSelect(null)
    }
    this.downAt = null
    this.drag = null
  }

  private applyCam(): void {
    this.cam.setAttribute('transform', `translate(${this.tx},${this.ty}) scale(${this.k})`)
  }

  zoomAt(mx: number, my: number, factor: number): void {
    const nk = Math.max(0.2, Math.min(3, this.k * factor))
    this.tx = mx - (mx - this.tx) * (nk / this.k)
    this.ty = my - (my - this.ty) * (nk / this.k)
    this.k = nk
    this.applyCam()
  }

  setData(nodes: KNode[], mastery: Record<string, Mastery>, now = Date.now(), relations: Relation[] = []): void {
    this.nodes = nodes
    this.mastery = mastery
    this.now = now
    this.relations = relations
    this.computeLayout()
    this.render()
  }

  setMode(mode: GraphMode): void {
    this.mode = mode
    const root = this.svg
    root.dataset.mode = mode
    // 「地基」模式要显示整条前置链，切模式必须重画边
    this.render()
    this.applyDim()
  }

  select(id: string | null): void {
    if (this.selected === id) {
      this.applyDim()
      return
    }
    this.selected = id
    // 前置箭头跟着选中状态走，所以选中变了必须重画边
    this.render()
    this.applyDim()
  }

  /** 当前可见内容的真实包围盒 —— 折叠后画布会小很多，不能用固定尺寸去适配 */
  private bounds(): { minX: number; minY: number; w: number; h: number } {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of this.vis) {
      const [x, y] = this.pos(n.id)
      const r = this.radiusOf(n.id) + 8
      minX = Math.min(minX, x - r)
      maxX = Math.max(maxX, x + r)
      minY = Math.min(minY, y - r)
      maxY = Math.max(maxY, y + r)
    }
    if (!isFinite(minX)) return { minX: 0, minY: 0, w: CW, h: CH }
    return { minX, minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
  }

  fit(): void {
    const b = this.bounds()
    const r = this.svg.getBoundingClientRect()
    const pad = 36
    const s = Math.min((r.width - pad * 2) / b.w, (r.height - pad * 2) / b.h)
    this.k = Math.max(0.3, Math.min(1.5, s))
    this.tx = (r.width - b.w * this.k) / 2 - b.minX * this.k
    this.ty = (r.height - b.h * this.k) / 2 - b.minY * this.k
    this.applyCam()
  }

  center(): void {
    const r = this.svg.getBoundingClientRect()
    this.k = Math.max(0.5, Math.min(1, r.height / CH))
    this.tx = r.width / 2 - CX * this.k
    this.ty = r.height / 2 - CY * this.k
    this.applyCam()
  }

  setFold(fold: boolean): void {
    this.fold = fold
    this.computeLayout()
    this.render()
  }

  isFolded(): boolean {
    return this.fold
  }

  private computeLayout(): void {
    const kidsAll = new Map<string, KNode[]>()
    for (const n of this.nodes) {
      if (!n.parentId) continue
      const list = kidsAll.get(n.parentId) ?? []
      list.push(n)
      kidsAll.set(n.parentId, list)
    }
    const root = this.nodes.find((n) => !n.parentId)
    this.depth.clear()
    if (!root) return

    const walkDepth = (id: string, d: number): void => {
      this.depth.set(id, d)
      for (const k of kidsAll.get(id) ?? []) walkDepth(k.id, d + 1)
    }
    walkDepth(root.id, 0)

    // 折叠时只保留前两层，被折叠的节点不参与布局，避免留下一圈空洞
    this.vis = this.nodes.filter((n) => !this.fold || (this.depth.get(n.id) ?? 0) <= 2)
    this.visIds = new Set(this.vis.map((n) => n.id))

    const kids = new Map<string, KNode[]>()
    for (const n of this.vis) {
      if (!n.parentId || !this.visIds.has(n.parentId)) continue
      const list = kids.get(n.parentId) ?? []
      list.push(n)
      kids.set(n.parentId, list)
    }

    const span = new Map<string, [number, number]>()
    let leaf = 0
    const post = (id: string): void => {
      const c = kids.get(id) ?? []
      if (c.length === 0) {
        span.set(id, [leaf, leaf])
        leaf++
        return
      }
      for (const k of c) post(k.id)
      const first = span.get(c[0].id)!
      const last = span.get(c[c.length - 1].id)!
      span.set(id, [first[0], last[1]])
    }
    post(root.id)

    const step = 360 / Math.max(1, leaf)
    this.ang.clear()
    for (const n of this.vis) {
      const s = span.get(n.id)
      if (!s) continue
      this.ang.set(n.id, -90 + ((s[0] + s[1]) / 2 + 0.5) * step)
    }
  }

  private pos(id: string): [number, number] {
    const d = Math.min(this.depth.get(id) ?? 0, 3)
    const r = RING[d]
    const a = ((this.ang.get(id) ?? 0) * Math.PI) / 180
    return [CX + r * Math.cos(a), CY + r * Math.sin(a) * TILT]
  }

  /**
   * 标签实测碰撞：用浏览器算出的包围盒，判断它离同层节点圆还有多少净空。
   * 比"估算字号宽度"可靠——中文字宽和缩放都不用自己猜。
   * 要求至少 6px 净空，否则算撞上（贴边也难看）。
   */
  private hitsNode(lb: SVGTextElement, nodes: { x: number; y: number; r: number }[]): boolean {
    let b: { x: number; y: number; width: number; height: number }
    try {
      b = lb.getBBox()
    } catch {
      return false // 还没排版，先当没撞
    }
    return nodes.some((n) => {
      const dx = Math.max(b.x - n.x, 0, n.x - (b.x + b.width))
      const dy = Math.max(b.y - n.y, 0, n.y - (b.y + b.height))
      // 包围盒到圆心的距离减去半径 = 到圆周的净空
      return Math.hypot(dx, dy) - n.r < 6
    })
  }

  private radiusOf(id: string): number {
    return RC[Math.min(this.depth.get(id) ?? 0, 3)]
  }

  /**
   * 在圆环上找一个"最空"的角度来放 L1/L2 标签。
   * 做法：把这层节点的角度排序，找出最大的角间隔，取其中点——
   * 这样标签永远落在两个节点之间，不会被圆形节点压住。
   */
  private gapAngleDeg(angles: number[]): number {
    if (angles.length === 0) return -90 // 没节点就放正上方
    const a = angles.map((x) => ((x % 360) + 360) % 360).sort((p, q) => p - q)
    let bestGap = -1
    let bestMid = a[0]
    for (let i = 0; i < a.length; i++) {
      const cur = a[i]
      const next = i + 1 < a.length ? a[i + 1] : a[0] + 360
      const gap = next - cur
      if (gap > bestGap) {
        bestGap = gap
        bestMid = cur + gap / 2
      }
    }
    return bestMid
  }

  private spiral(a: string, b: string): string {
    const da = Math.min(this.depth.get(a) ?? 0, 3)
    const db = Math.min(this.depth.get(b) ?? 0, 3)
    const t1 = this.ang.get(a) ?? 0
    const t2 = this.ang.get(b) ?? 0
    const pts: [number, number][] = []
    for (let i = 0; i <= 22; i++) {
      const t = i / 22
      const r = RING[da] + (RING[db] - RING[da]) * t
      const th = ((t1 + (t2 - t1) * t) * Math.PI) / 180
      pts.push([CX + r * Math.cos(th), CY + r * Math.sin(th) * TILT])
    }
    const trim = (p0: [number, number], p1: [number, number], rad: number): [number, number] => {
      const dx = p1[0] - p0[0]
      const dy = p1[1] - p0[1]
      const L = Math.hypot(dx, dy) || 1
      return [p0[0] + (dx / L) * rad, p0[1] + (dy / L) * rad]
    }
    pts[0] = trim(this.pos(a), pts[1], RC[da])
    pts[pts.length - 1] = trim(this.pos(b), pts[pts.length - 2], RC[db])
    return 'M' + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L')
  }

  /** 跨支路弧线：同时给出路径和"文字标签该放哪"的中点 */
  private chord(a: string, b: string, bow: boolean): { d: string; mid: [number, number] } {
    const pa = this.pos(a)
    const pb = this.pos(b)
    const dx = pb[0] - pa[0]
    const dy = pb[1] - pa[1]
    const L = Math.hypot(dx, dy) || 1
    const ra = this.radiusOf(a)
    const rb = this.radiusOf(b)
    const p1: [number, number] = [pa[0] + (dx / L) * ra, pa[1] + (dy / L) * ra]
    const p2: [number, number] = [pb[0] - (dx / L) * rb, pb[1] - (dy / L) * rb]
    let cx = (p1[0] + p2[0]) / 2
    let cy = (p1[1] + p2[1]) / 2
    if (bow) {
      cx += (CX - cx) * 0.42
      cy += (CY - cy) * 0.42
    }
    // 二次贝塞尔 t=0.5 的位置，正好是标签落点
    const mid: [number, number] = [
      0.25 * p1[0] + 0.5 * cx + 0.25 * p2[0],
      0.25 * p1[1] + 0.5 * cy + 0.25 * p2[1]
    ]
    return { d: `M${p1[0]},${p1[1]} Q${cx},${cy} ${p2[0]},${p2[1]}`, mid }
  }

  private render(): void {
    this.gRing.innerHTML = ''
    this.gEdge.innerHTML = ''
    this.gNode.innerHTML = ''
    this.gLabel.innerHTML = ''

    const maxDepth = this.fold ? 2 : 3
    for (let d = 1; d <= maxDepth; d++) {
      const e = el('ellipse', { class: 'ring', cx: CX, cy: CY, rx: RING[d], ry: RING[d] * TILT })
      this.gRing.append(e)
    }

    // 圆环标签：先落在该层节点的最大空隙里，再实测一次是否撞上节点；
    // 撞了就依次尝试"往外挪""往里挪"，保证永远不被圆形节点盖住
    for (let d = 1; d <= maxDepth; d++) {
      const here = this.vis
        .filter((n) => Math.min(this.depth.get(n.id) ?? 0, 3) === d)
        .map((n) => {
          const [x, y] = this.pos(n.id)
          return { x, y, r: RC[d] }
        })
      const deg = this.gapAngleDeg(here.length ? this.vis.filter((n) => Math.min(this.depth.get(n.id) ?? 0, 3) === d).map((n) => this.ang.get(n.id) ?? 0) : [])
      const a = (deg * Math.PI) / 180
      const text = ['', 'L1 板块', 'L2 考点', 'L3 方法'][d]
      const radii = [RING[d], RING[d] + RC[d] + 16, Math.max(RING[d - 1] + RC[d] + 16, RING[d] - RC[d] - 16)]

      let placed = false
      for (const rad of radii) {
        const lb = el('text', { class: 'ringlab', x: CX + rad * Math.cos(a), y: CY + rad * Math.sin(a) * TILT })
        lb.setAttribute('text-anchor', 'middle')
        lb.setAttribute('dominant-baseline', 'middle')
        lb.textContent = text
        this.gLabel.append(lb)
        if (!this.hitsNode(lb, here)) {
          placed = true
          break
        }
        lb.remove()
      }
      if (!placed) {
        // 实在放不下就不标了——宁可少一行字，也不要糊在节点上
        continue
      }
    }

    for (const n of this.vis) {
      if (n.parentId && this.visIds.has(n.parentId)) {
        this.addEdge(n.parentId, n.id, 'e-tree', this.spiral(n.parentId, n.id), false)
      }
    }
    const why = (a: string, b: string, kind: 'prereq' | 'confusable'): string => {
      const r = this.relations.find(
        (x) => x.kind === kind && ((x.a === a && x.b === b) || (x.a === b && x.b === a))
      )
      return r?.why ?? (kind === 'prereq' ? '前置' : '易混')
    }
    for (const n of this.vis) {
      for (const c of n.confusable) {
        if (!this.visIds.has(c) || n.id >= c) continue
        const geo = this.chord(n.id, c, false)
        this.addEdge(n.id, c, 'e-con', geo.d, false, why(n.id, c, 'confusable'), geo.mid)
      }
    }
    // 前置箭头默认不画：只有选中某个节点时，才显示和它相关的那几条。
    // （曾经有个"地基"模式会把整条前置链全画出来，图会糊成一片，已移除）
    const focus = this.selected
    for (const n of this.vis) {
      for (const p of n.prereq) {
        if (!this.visIds.has(p)) continue
        if (!(focus && (n.id === focus || p === focus))) continue
        const geo = this.chord(p, n.id, true)
        this.addEdge(p, n.id, 'e-pre', geo.d, true, why(p, n.id, 'prereq'), geo.mid)
      }
    }

    for (const n of this.vis) {
      const d = Math.min(this.depth.get(n.id) ?? 0, 3)
      const [px, py] = this.pos(n.id)
      const R = RC[d]
      const m = this.mastery[n.id]
      // 根节点只是容器，永远不染色
      const untouched = n.kind === 'root' || !m || (m.n === 0 && m.K === 0)
      const g = el('g', { class: 'node' + (untouched ? ' dead' : ''), 'data-id': n.id })
      g.append(
        el('circle', {
          cx: px,
          cy: py,
          r: R,
          fill: n.kind === 'root' ? COLOR.unmeasured : colorOf(m, this.now),
          stroke: 'rgba(0,0,0,.14)',
          'stroke-width': 1
        })
      )
      if (n.kind === 'skill') {
        g.append(el('circle', { cx: px, cy: py, r: R + 3.5, fill: 'none', stroke: 'rgba(0,0,0,.22)', 'stroke-width': 1, 'stroke-dasharray': '2 3' }))
      }
      const per = [2, 4, 3, 3][d]
      const fs = [13, 10.5, 9.5, 9][d]
      const lines = wrapText(n.name, per)
      const lh = fs + 2.2
      const y0 = py - ((lines.length - 1) * lh) / 2
      lines.forEach((s, i) => {
        const t = el('text', { x: px, y: y0 + i * lh, style: `font-size:${fs}px` })
        t.textContent = s
        g.append(t)
      })
      if (m && m.n > 0 && R >= 20) {
        const b = el('text', { x: px, y: py + R - 4, style: 'font-size:8px;fill:rgba(0,0,0,.42)' })
        b.textContent = masteryScore(m, this.now).toFixed(2)
        g.append(b)
      }

      g.addEventListener('click', (ev) => {
        ev.stopPropagation()
        this.onSelect(n.id)
      })
      g.addEventListener('mouseenter', () => this.hover(n.id))
      g.addEventListener('mouseleave', () => this.applyDim())
      this.gNode.append(g)
    }

    this.applyDim()
  }

  private addEdge(
    a: string,
    b: string,
    cls: string,
    d: string,
    arrow: boolean,
    label?: string,
    mid?: [number, number]
  ): void {
    const g = el('g', { class: 'edge', 'data-a': a, 'data-b': b })
    const p = el('path', { class: cls, d })
    if (arrow) p.setAttribute('marker-end', 'url(#arw)')
    g.append(p)
    if (label && mid) {
      const t = el('text', { class: 'elab', x: mid[0], y: mid[1] })
      t.textContent = label
      g.append(t)
    }
    this.gEdge.append(g)
  }

  private hover(id: string | null): void {
    const focus = id ?? this.selected
    this.gNode.querySelectorAll('.node').forEach((n) => {
      n.classList.toggle('dim', !!focus && n.getAttribute('data-id') !== focus)
    })
    this.gEdge.querySelectorAll('.edge').forEach((e) => {
      const on = !focus || e.getAttribute('data-a') === focus || e.getAttribute('data-b') === focus
      e.classList.toggle('dim', !on)
      // 只有当前关注节点的关系线才显示文字理由，否则满屏字
      e.classList.toggle('ctx', !!focus && on)
    })
  }

  private applyDim(): void {
    this.hover(this.selected)
    this.gNode.querySelectorAll('.node').forEach((n) => {
      if (this.mode !== 'gap') return
      const id = n.getAttribute('data-id') ?? ''
      const m = this.mastery[id]
      const weak = !m || m.n === 0 || masteryScore(m, this.now) < 0.4
      n.classList.toggle('dim', !weak)
    })
  }
}
