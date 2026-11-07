import type { KNode, Mastery, Relation } from '../../shared/types'
import { masteryScore } from '../../shared/mastery'
import {
  forceStep,
  measureLabel,
  separateBoxes,
  type ForceEdge,
  type ForceNode,
  type LabelMetrics
} from '../../main/domain/layout'

export type GraphMode = 'structure' | 'gap'

const NS = 'http://www.w3.org/2000/svg'

/** 逻辑画布：节点坐标都在这个空间里，缩放平移由相机负责。
 *  尺寸按节点数自适应——固定大画布会让 fit() 缩得太小，字就看不见了。 */
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

/** 深色底用白字，浅色底用深字——避免黄底白字看不清 */
const LIGHT_FILL = new Set([COLOR.yellow, COLOR.unmeasured])

function bandOf(m: Mastery | undefined, now: number): string {
  if (!m || (m.n === 0 && m.K === 0)) return 'unmeasured'
  const s = masteryScore(m, now)
  if (s < 0.25) return 'red'
  if (s < 0.4) return 'orange'
  if (s < 0.6) return 'yellow'
  return 'green'
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag)
  for (const k in attrs) e.setAttribute(k, String(attrs[k]))
  return e
}

export interface GraphHandlers {
  onSelect: (id: string | null) => void
  /** 用户拖动结束：把位置存下来，下次打开还在原地 */
  onMoveNode?: (id: string, x: number, y: number) => void
}

interface NodeBox extends ForceNode {
  id: string
  metrics: LabelMetrics
  node: KNode
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
  private gLabel: SVGGElement

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
  private edgeEls: { spec: EdgeSpec; line: SVGLineElement | SVGPathElement }[] = []

  constructor(svg: SVGSVGElement, handlers: GraphHandlers) {
    this.svg = svg
    this.handlers = handlers
    this.cam = el('g')
    this.gEdge = el('g')
    this.gNode = el('g')
    this.gLabel = el('g')
    const defs = el('defs')
    defs.innerHTML =
      '<marker id="arw" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M0,0.5 L9,5 L0,9.5 z" fill="#5b6472"/></marker>'
    this.svg.append(defs, this.cam)
    this.cam.append(this.gEdge, this.gNode, this.gLabel)

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

  /** 画布按节点数缩放：节点少时画布小，fit 之后字才不会缩成蚂蚁 */
  private resizeCanvas(n: number): void {
    const area = Math.max(1, n) * 9000
    const w = Math.round(Math.max(880, Math.sqrt(area * 1.55)))
    W = w
    H = Math.round(w / 1.55)
  }

  private buildEdges(nodes: KNode[], relations: Relation[]): EdgeSpec[] {
    const ids = new Set(nodes.map((n) => n.id))
    const out: EdgeSpec[] = []
    const seen = new Set<string>()
    for (const n of nodes) {
      if (n.parentId && ids.has(n.parentId)) out.push({ a: n.parentId, b: n.id, kind: 'tree' })
    }
    for (const r of relations) {
      if (!ids.has(r.a) || !ids.has(r.b)) continue
      const key = `${r.kind}:${[r.a, r.b].sort().join('|')}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ a: r.a, b: r.b, kind: r.kind === 'prereq' ? 'pre' : 'con', why: r.why })
    }
    return out
  }

  /** 深度（用于折叠）与测量 */
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

  private measure(): void {
    for (const n of this.nodes) {
      const isRoot = n.kind === 'root'
      const m = measureLabel(n.name, {
        font: isRoot ? 14 : 12.5,
        maxWidth: isRoot ? 14 * 8 : 12.5 * 7,
        maxLines: 3,
        padX: isRoot ? 13 : 10,
        padY: isRoot ? 9 : 7,
        minW: isRoot ? 74 : 46,
        minH: isRoot ? 40 : 30
      })
      const old = this.boxes.get(n.id)
      this.boxes.set(n.id, {
        id: n.id,
        node: n,
        metrics: m,
        x: old?.x ?? 0,
        y: old?.y ?? 0,
        w: m.boxW,
        h: m.boxH,
        vx: 0,
        vy: 0,
        pinned: old?.pinned
      })
    }
    // 清掉已经不存在的节点
    for (const id of [...this.boxes.keys()]) if (!this.nodes.some((n) => n.id === id)) this.boxes.delete(id)
  }

  /** 首次布局：先按圆环撒点（不是最终位置，只给力导向一个初始形状），再模拟 */
  private layout(iterations = 320): void {
    const vis = this.visibleNodes()
    const visIds = new Set(vis.map((n) => n.id))
    const list: NodeBox[] = []
    vis.forEach((n, i) => {
      const b = this.boxes.get(n.id)
      if (!b) return
      if (b.x === 0 && b.y === 0) {
        const ring = n.kind === 'root' ? 0 : this.depthOf(n.id)
        const r = 60 + ring * Math.min(W, H) * 0.16
        const a = (i / Math.max(1, vis.length)) * Math.PI * 2 + ring * 0.6
        b.x = W / 2 + Math.cos(a) * r
        b.y = H / 2 + Math.sin(a) * r
      }
      list.push(b)
    })

    // 结构边拉得更紧，父子才会成簇；关系边轻一点，只做轻微牵引
    const edges: ForceEdge[] = this.edges
      .filter((e) => visIds.has(e.a) && visIds.has(e.b))
      .map((e) => ({ a: e.a, b: e.b, strength: e.kind === 'tree' ? 2.2 : 0.7 }))

    const ideal = Math.sqrt((W * H) / Math.max(1, list.length)) * 0.55
    for (let i = 0; i < iterations; i++) {
      forceStep(list, edges, { w: W, h: H, ideal })
      if (i % 24 === 0) separateBoxes(list, 16, 6)
    }
    separateBoxes(list, 18, 30)
  }

  /** 用户拖过的位置：直接钉住，并且让邻居重新排一次 */
  setPositions(pos: Record<string, [number, number]>): void {
    let any = false
    for (const [id, [x, y]] of Object.entries(pos ?? {})) {
      const b = this.boxes.get(id)
      if (!b) continue
      b.x = x
      b.y = y
      b.pinned = true
      any = true
    }
    if (any) {
      const vis = this.visibleNodes().map((n) => this.boxes.get(n.id)).filter(Boolean) as NodeBox[]
      const edges = this.edges.map((e) => ({ a: e.a, b: e.b, strength: e.kind === 'tree' ? 2.2 : 0.7 }))
      const ideal = Math.sqrt((W * H) / Math.max(1, vis.length)) * 0.55
      for (let i = 0; i < 80; i++) forceStep(vis, edges, { w: W, h: H, ideal })
      separateBoxes(vis, 18, 24)
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
        this.dragNode = { id, grabX: p.x - b.x, grabY: p.y - b.y }
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
      b.x = Math.max(b.w / 2, Math.min(W - b.w / 2, p.x - this.dragNode.grabX))
      b.y = Math.max(b.h / 2, Math.min(H - b.h / 2, p.y - this.dragNode.grabY))
      this.moveNodeEl(b)
      this.updateEdgesFor(b.id)
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
        b.pinned = true
        this.handlers.onMoveNode?.(id, Math.round(b.x), Math.round(b.y))
        // 抖一下邻居，让它"让开"——拖完不是硬邦邦挪走一块
        const vis = this.visibleNodes().map((n) => this.boxes.get(n.id)).filter(Boolean) as NodeBox[]
        const edges = this.edges.map((x) => ({ a: x.a, b: x.b, strength: x.kind === 'tree' ? 2.2 : 0.7 }))
        const ideal = Math.sqrt((W * H) / Math.max(1, vis.length)) * 0.55
        for (let i = 0; i < 45; i++) forceStep(vis, edges, { w: W, h: H, ideal })
        separateBoxes(vis, 18, 16)
        this.render()
      }
      this.panFrom = null
      this.downAt = null
      return
    }
    // 空白处点一下（不是拖动）＝取消选中
    if (this.panFrom && this.downAt && this.selected) {
      const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y)
      const onNode = !!(e.target as Element)?.closest?.('.node')
      if (moved < 4 && !onNode) this.handlers.onSelect(null)
    }
    this.panFrom = null
    this.downAt = null
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

  /** 把所有节点装进视口 */
  fit(): void {
    const vis = this.visibleNodes().map((n) => this.boxes.get(n.id)).filter(Boolean) as NodeBox[]
    if (!vis.length) return
    const r = this.svg.getBoundingClientRect()
    const pad = 48
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
    const bw = maxX - minX
    const bh = maxY - minY
    const raw = Math.min((r.width - pad * 2) / bw, (r.height - pad * 2) / bh)
    // 下限 0.62：宁可让图超出视口（用户可以拖），也不要把字缩到看不清
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
    this.layout(200)
    this.render()
  }

  isFolded(): boolean {
    return this.fold
  }

  /* ---------------- 渲染 ---------------- */

  render(): void {
    this.gEdge.innerHTML = ''
    this.gNode.innerHTML = ''
    this.gLabel.innerHTML = ''
    this.edgeEls = []

    const vis = this.visibleNodes()
    const visIds = new Set(vis.map((n) => n.id))

    // 边先画，压在节点下面
    for (const spec of this.edges) {
      if (!visIds.has(spec.a) || !visIds.has(spec.b)) continue
      const a = this.boxes.get(spec.a)
      const b = this.boxes.get(spec.b)
      if (!a || !b) continue
      const g = el('g', { class: 'edge', 'data-a': spec.a, 'data-b': spec.b })
      const line = el('line', {
        class: `e-${spec.kind}`,
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y
      })
      if (spec.kind === 'pre') line.setAttribute('marker-end', 'url(#arw)')
      g.append(line)
      this.gEdge.append(g)
      this.edgeEls.push({ spec, line })
    }

    // 节点
    for (const n of vis) {
      const b = this.boxes.get(n.id)
      if (!b) continue
      const band = n.kind === 'root' ? 'root' : bandOf(this.mastery[n.id], this.now)
      const g = el('g', {
        class: `node ${n.kind === 'root' ? 'root' : band}`,
        'data-id': n.id,
        transform: `translate(${b.x},${b.y})`
      })
      const fill = n.kind === 'root' ? 'var(--ink)' : COLOR[band] ?? COLOR.unmeasured
      const rect = el('rect', {
        x: -b.w / 2,
        y: -b.h / 2,
        width: b.w,
        height: b.h,
        rx: 9,
        ry: 9,
        fill
      })
      g.append(rect)
      const dark = n.kind === 'root' || !LIGHT_FILL.has(fill)
      const lh = b.metrics.lines.length > 1 ? (b.metrics.height / b.metrics.lines.length) : 0
      const startY = -((b.metrics.lines.length - 1) * lh) / 2
      b.metrics.lines.forEach((line, i) => {
        const t = el('text', {
          x: 0,
          y: startY + i * lh,
          fill: dark ? '#ffffff' : '#1f2328',
          'font-size': n.kind === 'root' ? 14 : 12.5,
          'font-weight': n.kind === 'root' ? 600 : 500
        })
        t.textContent = line
        g.append(t)
      })
      this.gNode.append(g)
    }

    this.applyDim()
  }

  private moveNodeEl(b: NodeBox): void {
    const g = this.gNode.querySelector(`.node[data-id="${CSS.escape(b.id)}"]`) as SVGGElement | null
    if (g) g.setAttribute('transform', `translate(${b.x},${b.y})`)
  }

  private updateEdgesFor(id: string): void {
    const b = this.boxes.get(id)
    if (!b) return
    for (const { spec, line } of this.edgeEls) {
      if (spec.a !== id && spec.b !== id) continue
      const a = this.boxes.get(spec.a)
      const c = this.boxes.get(spec.b)
      if (!a || !c) continue
      line.setAttribute('x1', String(a.x))
      line.setAttribute('y1', String(a.y))
      line.setAttribute('x2', String(c.x))
      line.setAttribute('y2', String(c.y))
    }
  }

  /** 选中谁，就只显示和谁相关的那些线；缺口模式再压暗不弱的节点 */
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
    })
  }

  /** 当前布局快照（写回本地用） */
  snapshotPositions(): Record<string, [number, number]> {
    const out: Record<string, [number, number]> = {}
    for (const [id, b] of this.boxes) out[id] = [Math.round(b.x), Math.round(b.y)]
    return out
  }
}
