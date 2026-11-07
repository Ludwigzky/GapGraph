import { describe, expect, it } from 'vitest'
import packJson from '../resources/packs/gaokao-math-function.json'
import bankJson from '../resources/questions/gaokao-math-function.json'
import type { Pack, Question } from '../src/shared/types'
import { isCorrect, normalize } from '../src/main/domain/grading'

const pack = packJson as unknown as Pack
const questions = (bankJson as unknown as { questions: Question[] }).questions
const nodes = pack.nodes.filter((n) => n.kind !== 'root')

const accepted = (q: Question): string[] => (Array.isArray(q.answer) ? q.answer : [q.answer])

describe('题库：基本结构', () => {
  it('每道题的题型合法', () => {
    const bad = questions.filter((q) => !['single', 'blank', 'judge'].includes(q.type))
    expect(bad).toEqual([])
  })

  it('难度在 1–5 之间', () => {
    const bad = questions.filter((q) => !Number.isInteger(q.difficulty) || q.difficulty < 1 || q.difficulty > 5)
    expect(bad.map((q) => q.id)).toEqual([])
  })

  it('题干与解析都不为空', () => {
    const bad = questions.filter((q) => !q.stem?.trim() || !q.solution?.trim())
    expect(bad.map((q) => q.id)).toEqual([])
  })

  it('选择题恰好四个选项且互不相同', () => {
    const bad: string[] = []
    for (const q of questions) {
      if (q.type !== 'single') continue
      const opts = q.options ?? []
      if (opts.length !== 4) bad.push(q.id)
      else if (new Set(opts.map((o) => normalize(o))).size !== 4) bad.push(q.id)
    }
    expect(bad).toEqual([])
  })

  it('选择题的答案确实在选项里', () => {
    const bad: string[] = []
    for (const q of questions) {
      if (q.type !== 'single') continue
      const opts = q.options ?? []
      if (!accepted(q).some((a) => opts.some((o) => normalize(o) === normalize(a)))) bad.push(q.id)
    }
    expect(bad).toEqual([])
  })

  it('判断题答案只能是 true / false', () => {
    const bad = questions.filter((q) => q.type === 'judge' && !['true', 'false'].includes(String(q.answer)))
    expect(bad.map((q) => q.id)).toEqual([])
  })

  it('每道题都挂了一个主考点', () => {
    const bad = questions.filter((q) => !q.tags?.some((t) => t.primary))
    expect(bad.map((q) => q.id)).toEqual([])
  })

  it('题号唯一', () => {
    expect(new Set(questions.map((q) => q.id)).size).toBe(questions.length)
  })
})

describe('题库：覆盖度', () => {
  it('每个考点至少 2 道题（不能点进去是空的）', () => {
    const count: Record<string, number> = {}
    for (const q of questions) for (const t of q.tags) count[t.nodeId] = (count[t.nodeId] ?? 0) + 1
    const thin = nodes.filter((n) => (count[n.id] ?? 0) < 2).map((n) => n.name)
    expect(thin).toEqual([])
  })

  it('四个难度档都有题（否则热力表的"难"列永远是空的）', () => {
    const diff = new Set(questions.map((q) => q.difficulty))
    expect([...diff].sort()).toEqual([1, 2, 3, 4])
  })

  it('难题（4 档）至少 20 道，够撑起"难题崩"这个判断', () => {
    expect(questions.filter((q) => q.difficulty >= 4).length).toBeGreaterThanOrEqual(20)
  })
})

describe('题库：防止可猜规律', () => {
  it('选择题答案位置分布均衡，没有哪个字母超过 45%', () => {
    const pos: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 }
    let total = 0
    for (const q of questions) {
      if (q.type !== 'single' || !q.options) continue
      const idx = q.options.findIndex((o) => accepted(q).some((a) => normalize(a) === normalize(o)))
      if (idx < 0) continue
      pos['ABCD'[idx]]++
      total++
    }
    expect(total).toBeGreaterThan(20)
    for (const k of ['A', 'B', 'C', 'D']) {
      expect(pos[k] / total).toBeLessThan(0.45)
    }
  })

  it('题干归一化后不重复', () => {
    const seen = new Set<string>()
    const dup: string[] = []
    for (const q of questions) {
      const key = normalize(q.stem).replace(/\d/g, '#')
      if (seen.has(key)) dup.push(q.id)
      seen.add(key)
    }
    expect(dup).toEqual([])
  })
})

describe('判分：符号写法差异不该误判', () => {
  it('全角半角、根号、花括号写法都算对', () => {
    expect(normalize('根号10')).toBe(normalize('√10'))
    expect(normalize('2^{2x}-3')).toBe(normalize('2^(2x)-3'))
    expect(normalize('（1，2）')).toBe(normalize('(1,2)'))
    expect(normalize('x ≥ 1')).toBe(normalize('x>=1'))
  })

  it('一道题可以有多个可接受答案', () => {
    const q: Question = {
      id: 't',
      type: 'blank',
      difficulty: 2,
      stem: '测试',
      answer: ['log₂8', '3'],
      solution: '略',
      tags: [{ nodeId: 'x', weight: 1, primary: true }]
    }
    expect(isCorrect(q, '3')).toBe(true)
    expect(isCorrect(q, 'log2 8'.replace(' ', ''))).toBe(false)
    expect(isCorrect(q, '4')).toBe(false)
  })
})
