import { describe, expect, it } from 'vitest'
import { isUsablePack, normalizeGeneratedPack } from '../src/main/domain/pack'

const raw = {
  exam: '考研',
  subject: '数学一',
  chapter: '多元函数微分学',
  nodes: [
    { id: 'n1', name: '总览', parentId: null, kind: 'root', examWeight: 1, prereq: [], brief: '' },
    { id: 'n2', name: '偏导数', parentId: 'n1', kind: 'concept', examWeight: 0.9, prereq: [], brief: '' },
    { id: 'n3', name: '全微分', parentId: 'n2', kind: 'concept', examWeight: 0.8, prereq: ['n2'], brief: '' },
    { id: 'n4', name: '链式法则', parentId: 'n2', kind: 'skill', examWeight: 0.7, prereq: ['n2'], brief: '' },
    { id: 'n5', name: '隐函数', parentId: 'n1', kind: 'concept', examWeight: 0.6, prereq: [], brief: '' }
  ]
}

describe('AI 考纲规整', () => {
  it('正常输入原样保留结构', () => {
    const p = normalizeGeneratedPack(raw)
    expect(p.nodes).toHaveLength(5)
    expect(p.nodes[0].kind).toBe('root')
    expect(p.nodes[2].prereq).toEqual(['n2'])
    expect(p.title).toContain('多元函数微分学')
    expect(isUsablePack(p)).toBe(true)
  })

  it('没有 kind=root 时，把 parentId 为空的节点立为根', () => {
    const p = normalizeGeneratedPack({
      ...raw,
      nodes: raw.nodes.map((n) => ({ ...n, kind: 'concept' }))
    })
    expect(p.nodes.filter((n) => n.kind === 'root')).toHaveLength(1)
    expect(p.nodes[0].kind).toBe('root')
  })

  it('悬空的 parentId 挂回根节点，图不会断', () => {
    const p = normalizeGeneratedPack({
      ...raw,
      nodes: [...raw.nodes, { id: 'orphan', name: '孤儿', parentId: '不存在的id', kind: 'concept', examWeight: 0.5, prereq: [] }]
    })
    const orphan = p.nodes.find((n) => n.id === 'orphan')!
    expect(orphan.parentId).toBe('n1')
  })

  it('重复 id 会被改掉，不会互相覆盖', () => {
    const p = normalizeGeneratedPack({
      ...raw,
      nodes: [raw.nodes[0], { ...raw.nodes[1], id: 'n1' }]
    })
    expect(new Set(p.nodes.map((n) => n.id)).size).toBe(p.nodes.length)
  })

  it('prereq 里指向不存在节点的引用被清掉', () => {
    const p = normalizeGeneratedPack({
      ...raw,
      nodes: [...raw.nodes, { id: 'n9', name: 'x', parentId: 'n1', kind: 'concept', examWeight: 0.5, prereq: ['ghost'] }]
    })
    expect(p.nodes.find((n) => n.id === 'n9')!.prereq).toEqual([])
  })

  it('权重被夹到 0.2–1.0，0 和 5 都不会漏过去', () => {
    const p = normalizeGeneratedPack({
      ...raw,
      nodes: [
        raw.nodes[0],
        { id: 'a', name: 'a', parentId: 'n1', kind: 'concept', examWeight: 0 },
        { id: 'b', name: 'b', parentId: 'n1', kind: 'concept', examWeight: 5 }
      ]
    })
    expect(p.nodes.find((n) => n.id === 'a')!.examWeight).toBe(0.2)
    expect(p.nodes.find((n) => n.id === 'b')!.examWeight).toBe(1)
  })

  it('父链成环时会被打断，画图不会死循环', () => {
    const p = normalizeGeneratedPack({
      exam: 'x',
      subject: 'y',
      chapter: 'z',
      nodes: [
        { id: 'r', name: 'root', parentId: null, kind: 'root', examWeight: 1 },
        { id: 'a', name: 'a', parentId: 'b', kind: 'concept', examWeight: 0.5 },
        { id: 'b', name: 'b', parentId: 'a', kind: 'concept', examWeight: 0.5 }
      ]
    })
    expect(p.nodes.length).toBe(3)
    expect(p.nodes.filter((n) => n.kind === 'root')).toHaveLength(1)
  })

  it('节点少于 5 个不算可用 pack', () => {
    const p = normalizeGeneratedPack(raw)
    expect(isUsablePack(p)).toBe(true)
    expect(isUsablePack({ ...p, nodes: p.nodes.slice(0, 4) })).toBe(false)
  })
})
