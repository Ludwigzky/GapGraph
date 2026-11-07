import { describe, expect, it } from 'vitest'
import { clearExplain, explainCount, explainOf, loadExplains, saveExplain } from '../src/renderer/src/explain'
import type { DetailedExplain } from '../src/renderer/src/ai'

/** 用一个内存版 localStorage 跑单测（jsdom 环境里本来就有，这里做最小兜底） */
const store = new Map<string, string>()
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k)
    },
    configurable: true
  })
}

const make = (definition: string): DetailedExplain => ({
  definition,
  basics: ['b1', 'b2'],
  exams: ['e1'],
  keypoints: ['k1'],
  ms: 1234,
  at: Date.UTC(2026, 0, 1)
})

describe('详细讲解缓存', () => {
  it('存进去能按板块 + 考点取回来', () => {
    saveExplain('packA', 'n1', make('定义 A'))
    const got = explainOf('packA', 'n1')
    expect(got?.definition).toBe('定义 A')
    expect(got?.exams).toEqual(['e1'])
  })

  it('不同板块互不干扰', () => {
    saveExplain('packA', 'n1', make('A 的定义'))
    saveExplain('packB', 'n1', make('B 的定义'))
    expect(explainOf('packA', 'n1')?.definition).toBe('A 的定义')
    expect(explainOf('packB', 'n1')?.definition).toBe('B 的定义')
  })

  it('同一节点重复生成会覆盖，不会堆两份', () => {
    saveExplain('packA', 'n2', make('旧版'))
    saveExplain('packA', 'n2', make('新版'))
    expect(explainOf('packA', 'n2')?.definition).toBe('新版')
    expect(Object.keys(loadExplains('packA')).length).toBeGreaterThan(0)
  })

  it('没生成过的节点返回 null，不返回半个空对象', () => {
    expect(explainOf('packC', 'nope')).toBe(null)
  })

  it('可以单独清掉一个节点（比如生成得不对想重来）', () => {
    saveExplain('packD', 'n1', make('x'))
    clearExplain('packD', 'n1')
    expect(explainOf('packD', 'n1')).toBe(null)
  })

  it('统计有多少考点生成过详细版', () => {
    saveExplain('packE', 'a', make('1'))
    saveExplain('packE', 'b', make('2'))
    expect(explainCount('packE')).toBe(2)
  })

  it('存档坏了不抛错，当成没有', () => {
    localStorage.setItem('gapgraph.explain.broken.v1', '{不是 json')
    expect(explainOf('broken', 'x')).toBe(null)
  })
})
