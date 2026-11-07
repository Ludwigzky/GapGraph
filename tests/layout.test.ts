import { describe, expect, it } from 'vitest'
import {
  forceStep,
  measureLabel,
  separateBoxes,
  textWidth,
  type Box,
  type ForceEdge,
  type ForceNode
} from '../src/main/domain/layout'

describe('量文字：框一定装得下字', () => {
  it('短名字一行装得下，框比字宽', () => {
    const m = measureLabel('定义域')
    expect(m.lines).toHaveLength(1)
    expect(m.boxW).toBeGreaterThan(m.width)
    expect(m.truncated).toBe(false)
  })

  it('长名字会折行，不会撑破框', () => {
    const m = measureLabel('函数零点存在性定理的应用')
    expect(m.lines.length).toBeGreaterThan(1)
    for (const line of m.lines) expect(textWidth(line, 12.5)).toBeLessThanOrEqual(m.boxW)
  })

  it('超长名字截断并加省略号，行数不超过上限', () => {
    const m = measureLabel('非常非常非常长的考点名称用来测试截断行为是否正确', { maxLines: 2 })
    expect(m.lines).toHaveLength(2)
    expect(m.truncated).toBe(true)
    expect(m.lines[1].endsWith('…')).toBe(true)
  })

  it('框高度随行数增加（多行的节点更大）', () => {
    const one = measureLabel('定义域')
    const two = measureLabel('函数零点存在性定理')
    expect(two.boxH).toBeGreaterThan(one.boxH)
  })

  it('中文字比英文占宽更多', () => {
    expect(textWidth('函数', 12.5)).toBeGreaterThan(textWidth('ab', 12.5))
  })

  it('空名字也能安全量出框', () => {
    const m = measureLabel('')
    expect(m.boxW).toBeGreaterThan(0)
    expect(m.boxH).toBeGreaterThan(0)
  })
})

describe('拆重叠：节点不会互相压住', () => {
  const mk = (id: string, x: number, y: number, w = 80, h = 34): Box => ({ id, x, y, w, h })

  const intersects = (a: Box, b: Box): boolean =>
    Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2

  it('两个完全重合的框会被推开', () => {
    const boxes = [mk('a', 100, 100), mk('b', 100, 100)]
    separateBoxes(boxes, 10)
    expect(intersects(boxes[0], boxes[1])).toBe(false)
  })

  it('已经分开的框不会被动', () => {
    const boxes = [mk('a', 0, 0), mk('b', 500, 500)]
    const before = boxes.map((b) => ({ ...b }))
    separateBoxes(boxes, 10)
    expect(boxes[0].x).toBe(before[0].x)
    expect(boxes[1].y).toBe(before[1].y)
  })

  it('一堆挤在一起的框，最后两两不重叠', () => {
    const boxes = Array.from({ length: 12 }, (_, i) => mk(`n${i}`, 300 + (i % 3) * 5, 300 + (i % 4) * 5))
    separateBoxes(boxes, 12, 200)
    let bad = 0
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) if (intersects(boxes[i], boxes[j])) bad++
    expect(bad).toBe(0)
  })

  it('给了边界时不会把节点推到画布外', () => {
    const boxes = [mk('a', 5, 5), mk('b', 5, 5)]
    separateBoxes(boxes, 10, 40, { w: 200, h: 200 })
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x).toBeLessThanOrEqual(200)
      expect(b.y).toBeGreaterThanOrEqual(0)
      expect(b.y).toBeLessThanOrEqual(200)
    }
  })
})

describe('力导向：相关的靠拢，无关的推开', () => {
  const mkNode = (id: string, x: number, y: number): ForceNode => ({
    id,
    x,
    y,
    w: 70,
    h: 32,
    vx: 0,
    vy: 0
  })

  it('有边的两个节点会互相靠近', () => {
    const nodes = [mkNode('a', 100, 300), mkNode('b', 900, 300)]
    const edges: ForceEdge[] = [{ a: 'a', b: 'b', strength: 2 }]
    const before = Math.abs(nodes[0].x - nodes[1].x)
    for (let i = 0; i < 60; i++) forceStep(nodes, edges, { w: 1000, h: 600 })
    expect(Math.abs(nodes[0].x - nodes[1].x)).toBeLessThan(before)
  })

  it('没有边的节点会被排斥拉开', () => {
    const nodes = [mkNode('a', 500, 300), mkNode('b', 510, 300)]
    const before = Math.hypot(nodes[0].x - nodes[1].x, nodes[0].y - nodes[1].y)
    for (let i = 0; i < 30; i++) forceStep(nodes, [], { w: 1000, h: 600 })
    const after = Math.hypot(nodes[0].x - nodes[1].x, nodes[0].y - nodes[1].y)
    expect(after).toBeGreaterThan(before)
  })

  it('被拖住的节点不会被物理推走', () => {
    const nodes = [mkNode('a', 300, 300), mkNode('b', 310, 300)]
    nodes[0].pinned = true
    for (let i = 0; i < 40; i++) forceStep(nodes, [], { w: 1000, h: 600 })
    expect(nodes[0].x).toBe(300)
    expect(nodes[0].y).toBe(300)
  })

  it('节点不会飞出画布', () => {
    const nodes = [mkNode('a', 10, 10), mkNode('b', 990, 590)]
    for (let i = 0; i < 80; i++) forceStep(nodes, [], { w: 1000, h: 600 })
    for (const n of nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0)
      expect(n.x).toBeLessThanOrEqual(1000)
      expect(n.y).toBeGreaterThanOrEqual(0)
      expect(n.y).toBeLessThanOrEqual(600)
    }
  })

  it('完全重合的两个节点也能分开（有确定性错开）', () => {
    const nodes = [mkNode('a', 500, 300), mkNode('b', 500, 300)]
    for (let i = 0; i < 40; i++) forceStep(nodes, [], { w: 1000, h: 600 })
    expect(Math.hypot(nodes[0].x - nodes[1].x, nodes[0].y - nodes[1].y)).toBeGreaterThan(5)
  })

  it('单步位移被限幅：一帧不会瞬移（动画手感的关键）', () => {
    const nodes = [mkNode('a', 100, 300), mkNode('b', 900, 300)]
    const before = { x: nodes[0].x, y: nodes[0].y }
    forceStep(nodes, [{ a: 'a', b: 'b', strength: 3 }], { w: 1000, h: 600, maxStep: 4.5 })
    const moved = Math.hypot(nodes[0].x - before.x, nodes[0].y - before.y)
    expect(moved).toBeLessThanOrEqual(4.6)
  })

  it('限幅后连续多帧仍然能收敛（不会因为步子小就卡住）', () => {
    const nodes = [mkNode('a', 100, 300), mkNode('b', 900, 300)]
    const before = Math.abs(nodes[0].x - nodes[1].x)
    for (let i = 0; i < 200; i++)
      forceStep(nodes, [{ a: 'a', b: 'b', strength: 3 }], { w: 1000, h: 600, maxStep: 4.5 })
    expect(Math.abs(nodes[0].x - nodes[1].x)).toBeLessThan(before)
  })
})

describe('软分离：一次只推一部分，才像排斥', () => {
  const mk = (id: string, x: number, y: number): Box => ({ id, x, y, w: 80, h: 34 })

  it('stiffness=0.35 时单次只推开一小部分', () => {
    const a = mk('a', 100, 100)
    const b = mk('b', 100, 100)
    separateBoxes([a, b], 0, 1, undefined, 0.35)
    const gap = Math.hypot(a.x - b.x, a.y - b.y)
    // 完全重合时只错开一点点，不是一下推到底
    expect(gap).toBeGreaterThan(0)
    expect(gap).toBeLessThan(30)
  })

  it('多帧累积后仍然能完全分开', () => {
    const boxes = [mk('a', 100, 100), mk('b', 100, 100)]
    for (let i = 0; i < 60; i++) separateBoxes(boxes, 10, 2, undefined, 0.35)
    const overlapX = Math.abs(boxes[0].x - boxes[1].x) < 80
    const overlapY = Math.abs(boxes[0].y - boxes[1].y) < 34
    expect(overlapX && overlapY).toBe(false)
  })
})
