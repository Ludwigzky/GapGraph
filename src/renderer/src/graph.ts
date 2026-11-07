import type { KNode, Mastery, Relation } from '../../shared/types'
import { masteryScore } from '../../shared/mastery'
import { forceStep, separateBoxes, textWidth, type ForceEdge, type ForceNode } from '../../main/domain/layout'

export type GraphMode = 'structure' | 'gap'

const NS = 'http://www.w3.org/2000/svg'

/** 逻辑画布：按节点数自适应，避免 fit 之后字缩成蚂蚁 */
let W = 1000
let H = 660

/** 颜色只编码掌握度这一件事 */
const COLOR: Record<string, string> = {
  red: 'var(--c1)',
  orange: 'var(--c2)',
  yellow: 'var(--c3)',
  green: 'var(--c5)',
  unmeasured: 'var(--c0)'
}

const LABEL_FONT = 12.5
const LABEL_GAP = 7
const MAX_LABEL_W = 132
const DOT_R = 7
const ROOT_R = 10

function bandOf(m: Mastery | undefined, now: number): string {
  if (!m || (m.n === 0 && m.K === 0)) return 'unmeasured'
  const s = masteryScore(m, now)
  if (s < 0.25) return 'red'
  if (s < 0.4) return 'orange'
  if (s < 0.6) return 'yellow'
  return 'green'
}

/** 文字太长就截断加省略号——标签只做"认得出"，完整名字在右栏 */
function fitLabel(name: string): string {
  const raw = [...String(name ?? '')]
  const chars = raw.length ? raw : ['?']
  let out = ''
  for (const ch of chars) {
    if (textWidth(out + ch, LABEL_FONT) > MAX_LABEL_W - LABEL_FONT) {
      return out + '…'
    }
    out += ch
  }
  return out
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag)
  for (const k in attrs) e.setAttribute(k, String(attrs[k]))
  return e
}

export interface GraphHandlers {
  onSelect: (id: string | null) => void
  onMoveNode?: (id: string, x: number, y: number) => void
}

/**
 * 一个节点 = 一个小圆点 + 旁边一行字。
 * 碰撞箱不是圆点本身，而是"圆点 + 文字"的整体矩形——
 * 否则字会互相压，那比圆点重叠更难读。
 */
interface NodeBox extends ForceNode {
  id: string
  node: KNode
  label: string
  /** 圆点半径 */
  r: number
  /** 碰撞箱中心到圆点的水平偏移（文字在右侧，所以是正数） */
  dx: number
  /** 文字宽度 */
  labelW: number
}

interface EdgeSpec {
  a: string
  b: string
  kind: 'tree' | 'pre' | 'con'
  why?: string
}

export class KnowledgeGraph {
  private svg: SVGSVGElement
  private cam: SVGGElement
  private gEdge: SVGGElement
  private gNode: SVGGElement

  private nodes: KNode[] = []
  private boxes = new Map<string, NodeBox>()
  private edges: EdgeSpec[] = []
  private mastery: Record<string, Mastery> = {}
  private now = Date.now()
  private selected: string | null = null
  private mode: GraphMode = 'structure'
  private fold = false
  private handlers: GraphHandlers

  private k = 1
  private tx = 0
  private ty = 0

  private dragNode: { id: string; grabX: number; grabY: number } | null = null
  private panFrom: { x: number; y: number; tx: number; ty: number } | null = null
  private downAt: { x: number; y: number } | null = null
  private edgeEls: { spec: EdgeSpec; line: SVGLineElement }[] = []

  constructor(svg: SVGSVGElement, handlers: GraphHandlers) {
    this.svg = svg
    this.handlers = handlers
    this.cam = el('g')
    this.gEdge = el('g')
    this.gNode = el('g')
    const defs = el('defs')
    defs.innerHTML =
      '<marker id="arw" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M0,0.5 L9,5 L0,9.5 z" fill="#5b6472"/></marker>'
    this.svg.append(defs, this.cam)
    this.cam.append(this.gEdge, this.gNode)

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

  /* ---------------- 数据 ---------------- */

  setData(nodes: KNode[], mastery: Record<string, Mastery>, now = Date.now(), relations: Relation[] = []): void {
    this.nodes = nodes
    this.mastery = mastery
    this.now = now
    this.resizeCanvas(nodes.length)
    this.edges = this.buildEdges(nodes, relations)
    this.measure()
    this.layout()
    this.render()
  }

  private resizeCanvas(n: number): void {
    const area = Math.max(1, n) * 9000
    W = Math.round(Math.max(880, Math.sqrt(area * 1.55)))
    H = Math.round(W / 1.55)
  }

  private buildEdges(nodes: KNode[], relations: Relation[]): EdgeSpec[] {
    const ids = new Set(nodes.map((n) => n.id))
    const out: EdgeSpec[] = []
    const seen = new Set<string>()
    for (const n of nodes) if (n.parentId && ids.has(n.parentId)) out.push({ a: n.parentId, b: n.id, kind: 'tree' })
    for (const r of relations) {
      if (!ids.has(r.a) || !ids.has(r.b)) continue
      const key = `${r.kind}:${[r.a, r.b].sort().join('|')}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ a: r.a, b: r.b, kind: r.kind === 'prereq' ? 'pre' : 'con', why: r.why })
    }
    return out
  }

  private depthOf(id: string): number {
    const byId = new Map(this.nodes.map((n) => [n.id, n]))
    let cur = byId.get(id)
    let d = 0
    const guard = new Set<string>()
    while (cur && cur.parentId && !guard.has(cur.id)) {
      guard.add(cur.id)
      cur = byId.get(cur.parentId)
      d++
      if (d > 12) break
    }
    return d
  }

  private visibleNodes(): KNode[] {
    if (!this.fold) return this.nodes
    return this.nodes.filter((n) => n.kind === 'root' || this.depthOf(n.id) <= 2)
  }

  /** 量出"圆点 + 文字"的整体碰撞箱 */
  private measure(): void {
    for (const n of this.nodes) {
      const r = n.kind === 'root' ? ROOT_R : DOT_R
      const label = fitLabel(n.name)
      const labelW = textWidth(label, LABEL_FONT)
      const boxW = r * 2 + LABEL_GAP + labelW + 8
      const boxH = Math.max(r * 2 + 8, LABEL_FONT * 1.6)
      const dx = boxW / 2 - r
      const old = this.boxes.get(n.id)
      this.boxes.set(n.id, {
        id: n.id,
        node: n,
        label,
        r,
        dx,
        labelW,
        x: old?.x ?? 0,
        y: old?.y ?? 0,
        w: boxW,
        h: boxH,
        vx: 0,
        vy: 0,
        pinned: old?.pinned
      })
    }
    for (const id of [...this.boxes.keys()]) if (!this.nodes.some((n) => n.id === id)) this.boxes.delete(id)
  }

  private physicsEdges(visIds: Set<string>): ForceEdge[] {
    return this.edges
      .filter((e) => visIds.has(e.a) && visIds.has(e.b))
      .map((e) => ({ a: e.a, b: e.b, strength: e.kind === 'tree' ? 2.4 : 0.6 }))
  }

  private listOfVisible(): NodeBox[] {
    return this.visibleNodes()
      .map((n) => this.boxes.get(n.id))
      .filter((b): b is NodeBox => !!b)
  }

  private layout(iterations = 340): void {
    const vis = this.visibleNodes()
    const list: NodeBox[] = []
    vis.forEach((n, i) => {
      const b = this.boxes.get(n.id)
      if (!b) return
      if (b.x === 0 && b.y === 0) {
        const ring = n.kind === 'root' ? 0 : this.depthOf(n.id)
        const rad = 60 + ring * Math.min(W, H) * 0.16
        const a = (i / Math.max(1, vis.length)) * Math.PI * 2 + ring * 0.6
        b.x = W / 2 + Math.cos(a) * rad
        b.y = H / 2 + Math.sin(a) * rad
      }
      list.push(b)
    })
    if (!list.length) return
    const edges = this.physicsEdges(new Set(list.map((b) => b.id)))
    const ideal = Math.sqrt((W * H) / list.length) * 0.5
    for (let i = 0; i < iterations; i++) {
      forceStep(list, edges, { w: W, h: H, ideal })
      if (i % 20 === 0) separateBoxes(list, 14, 6)
    }
    separateBoxes(list, 16, 40)
  }

  setPositions(pos: Record<string, [number, number]>): void {
    let any = false
    for (const [id, [x, y]] of Object.entries(pos ?? {})) {
      const b = this.boxes.get(id)
      if (!b) continue
      // 存的是圆点坐标，碰撞箱中心要加回偏移
      b.x = x + b.dx
      b.y = y
      b.pinned = true
      any = true
    }
    if (any) {
      const list = this.listOfVisible()
      const edges = this.physicsEdges(new Set(list.map((b) => b.id)))
      const ideal = Math.sqrt((W * H) / Math.max(1, list.length)) * 0.5
      for (let i = 0; i < 70; i++) forceStep(list, edges, { w: W, h: H, ideal })
      separateBoxes(list, 16, 24)
      this.render()
    }
  }

  /* ---------------- 交互 ---------------- */

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const r = this.svg.getBoundingClientRect()
    this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0016))
  }

  private toGraph(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.svg.getBoundingClientRect()
    return { x: (clientX - r.left - this.tx) / this.k, y: (clientY - r.top - this.ty) / this.k }
  }

  private onDown = (e: PointerEvent): void => {
    const t = e.target as Element
    const nodeEl = t.closest?.('.node') as SVGGElement | null
    this.downAt = { x: e.clientX, y: e.clientY }
    if (nodeEl) {
      const id = nodeEl.getAttribute('data-id') ?? ''
      const b = this.boxes.get(id)
      if (b) {
        const p = this.toGraph(e.clientX, e.clientY)
        // 抓的是圆点，不是碰撞箱中心
        const dotX = b.x - b.dx
        this.dragNode = { id, grabX: p.x - dotX, grabY: p.y - b.y }
        b.pinned = true
        nodeEl.classList.add('dragging')
      }
      return
    }
    this.panFrom = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty }
  }

  private onMove = (e: PointerEvent): void => {
    if (this.dragNode) {
      const b = this.boxes.get(this.dragNode.id)
      if (!b) return
      const p = this.toGraph(e.clientX, e.clientY)
      const dotX = Math.max(b.r, Math.min(W - b.r, p.x - this.dragNode.grabX))
      const dotY = Math.max(b.h / 2, Math.min(H - b.h / 2, p.y - this.dragNode.grabY))
      b.x = dotX + b.dx
      b.y = dotY
      // 拖的同时让周围实时让开——这是"碰撞箱"的手感来源
      this.relaxAround(b.id)
      this.syncAll()
      return
    }
    if (!this.panFrom) return
    this.tx = this.panFrom.tx + (e.clientX - this.panFrom.x)
    this.ty = this.panFrom.ty + (e.clientY - this.panFrom.y)
    this.applyCam()
  }

  private onUp = (e: PointerEvent): void => {
    if (this.dragNode) {
      const b = this.boxes.get(this.dragNode.id)
      const id = this.dragNode.id
      this.dragNode = null
      this.gNode.querySelector('.dragging')?.classList.remove('dragging')
      if (b) {
        this.handlers.onMoveNode?.(id, Math.round(b.x - b.dx), Math.round(b.y))
        // 松手后再收敛几轮，让它停在稳定的位置
        const list = this.listOfVisible()
        const edges = this.physicsEdges(new Set(list.map((x) => x.id)))
        const ideal = Math.sqrt((W * H) / Math.max(1, list.length)) * 0.5
        for (let i = 0; i < 24; i++) forceStep(list, edges, { w: W, h: H, ideal })
        separateBoxes(list, 16, 18)
        this.render()
      }
      this.panFrom = null
      this.downAt = null
      return
    }
    if (this.panFrom && this.downAt && this.selected) {
      const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y)
      const onNode = !!(e.target as Element)?.closest?.('.node')
      if (moved < 4 && !onNode) this.handlers.onSelect(null)
    }
    this.panFrom = null
    this.downAt = null
  }

  /** 拖动时只算"被拖的这个不动，其它让开"，两三轮就够 */
  private relaxAround(activeId: string): void {
    const list = this.listOfVisible()
    const box = this.boxes.get(activeId)
    if (box) box.pinned = true
    const edges = this.physicsEdges(new Set(list.map((b) => b.id)))
    const ideal = Math.sqrt((W * H) / Math.max(1, list.length)) * 0.5
    for (let i = 0; i < 3; i++) {
      forceStep(list, edges, { w: W, h: H, ideal })
      separateBoxes(list, 14, 4)
    }
    if (box) {
      // 被拖的节点不能被推走
      box.vx = 0
      box.vy = 0
    }
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

  fit(): void {
    const vis = this.listOfVisible()
    if (!vis.length) return
    const r = this.svg.getBoundingClientRect()
    const pad = 44
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const b of vis) {
      minX = Math.min(minX, b.x - b.w / 2)
      minY = Math.min(minY, b.y - b.h / 2)
      maxX = Math.max(maxX, b.x + b.w / 2)
      maxY = Math.max(maxY, b.y + b.h / 2)
    }
    const raw = Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY))
    this.k = Math.max(0.62, Math.min(1.6, raw))
    this.tx = r.width / 2 - ((minX + maxX) / 2) * this.k
    this.ty = r.height / 2 - ((minY + maxY) / 2) * this.k
    this.applyCam()
  }

  select(id: string | null): void {
    if (this.selected === id) {
      this.applyDim()
      return
    }
    this.selected = id
    this.applyDim()
  }

  setMode(mode: GraphMode): void {
    this.mode = mode
    this.svg.dataset.mode = mode
    this.applyDim()
  }

  setFold(fold: boolean): void {
    this.fold = fold
    this.measure()
    this.layout(220)
    this.render()
  }

  isFolded(): boolean {
    return this.fold
  }

  /* ---------------- 渲染 ---------------- */

  private dotPos(b: NodeBox): { x: number; y: number } {
    return { x: b.x - b.dx, y: b.y }
  }

  render(): void {
    this.gEdge.innerHTML = ''
    this.gNode.innerHTML = ''
    this.edgeEls = []

    const vis = this.visibleNodes()
    const visIds = new Set(vis.map((n) => n.id))

    for (const spec of this.edges) {
      if (!visIds.has(spec.a) || !visIds.has(spec.b)) continue
      const a = this.boxes.get(spec.a)
      const b = this.boxes.get(spec.b)
      if (!a || !b) continue
      const pa = this.dotPos(a)
      const pb = this.dotPos(b)
      const g = el('g', { class: 'edge', 'data-a': spec.a, 'data-b': spec.b })
      const line = el('line', { class: `e-${spec.kind}`, x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y })
      if (spec.kind === 'pre') line.setAttribute('marker-end', 'url(#arw)')
      g.append(line)
      this.gEdge.append(g)
      this.edgeEls.push({ spec, line })
    }

    for (const n of vis) {
      const b = this.boxes.get(n.id)
      if (!b) continue
      const band = n.kind === 'root' ? 'root' : bandOf(this.mastery[n.id], this.now)
      const p = this.dotPos(b)
      const g = el('g', { class: `node ${n.kind === 'root' ? 'root' : band}`, 'data-id': n.id, transform: `translate(${p.x},${p.y})` })
      const fill = n.kind === 'root' ? 'var(--ink)' : COLOR[band] ?? COLOR.unmeasured

      // 命中区：圆点 + 文字整块都能点，不然小圆点太难点中
      g.append(
        el('rect', {
          class: 'hit',
          x: -b.r - 4,
          y: -b.h / 2,
          width: b.w - 2,
          height: b.h,
          rx: 6,
          fill: 'transparent'
        })
      )
      g.append(el('circle', { class: 'dot', r: b.r, fill }))
      const t = el('text', { x: b.r + LABEL_GAP, y: 0, 'font-size': LABEL_FONT, 'font-weight': n.kind === 'root' ? 700 : 500 })
      t.textContent = b.label
      g.append(t)
      this.gNode.append(g)
    }

    this.applyDim()
  }

  /** 拖动过程中把位置同步到 DOM（不重建节点，避免闪烁） */
  private syncAll(): void {
    for (const [id, b] of this.boxes) {
      const g = this.gNode.querySelector(`.node[data-id="${CSS.escape(id)}"]`) as SVGGElement | null
      if (!g) continue
      const p = this.dotPos(b)
      g.setAttribute('transform', `translate(${p.x},${p.y})`)
    }
    for (const { spec, line } of this.edgeEls) {
      const a = this.boxes.get(spec.a)
      const c = this.boxes.get(spec.b)
      if (!a || !c) continue
      const pa = this.dotPos(a)
      const pc = this.dotPos(c)
      line.setAttribute('x1', String(pa.x))
      line.setAttribute('y1', String(pa.y))
      line.setAttribute('x2', String(pc.x))
      line.setAttribute('y2', String(pc.y))
    }
  }

  private applyDim(): void {
    const focus = this.selected
    this.gEdge.querySelectorAll('.edge').forEach((e) => {
      const on = !!focus && (e.getAttribute('data-a') === focus || e.getAttribute('data-b') === focus)
      e.classList.toggle('ctx', on)
      e.classList.toggle('dim', !!focus && !on)
    })
    this.gNode.querySelectorAll('.node').forEach((n) => {
      const id = n.getAttribute('data-id') ?? ''
      let dim = !!focus && id !== focus
      if (!focus && this.mode === 'gap') {
        const m = this.mastery[id]
        const weak = !m || m.n === 0 || masteryScore(m, this.now) < 0.4
        dim = !weak
      }
      n.classList.toggle('dim', dim)
      n.classList.toggle('sel', id === focus)
    })
  }

  snapshotPositions(): Record<string, [number, number]> {
    const out: Record<string, [number, number]> = {}
    for (const [id, b] of this.boxes) {
      const p = this.dotPos(b)
      out[id] = [Math.round(p.x), Math.round(p.y)]
    }
    return out
  }
}
