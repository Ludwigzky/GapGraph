import { describe, expect, it } from 'vitest'
import type { AttemptRecord, KNode, Mastery, Question } from '../src/shared/types'
import { buildAttemptRecord, nodesOfAttempt } from '../src/main/domain/attempt-log'
import { buildHeatmap, summarizeHeat } from '../src/main/domain/heatmap'
import { band, evidenceOf, freshMastery } from '../src/shared/mastery'

const NOW = Date.UTC(2026, 0, 10)

const q = (id: string, difficulty: number, tags: Question['tags']): Question => ({
  id,
  type: 'single',
  stem: '题干',
  options: ['a', 'b', 'c', 'd'],
  answer: 'a',
  difficulty,
  tags
})

const node = (id: string): KNode => ({
  id,
  name: id,
  parentId: 'root',
  kind: 'concept',
  examWeight: 0.8,
  prereq: [],
  confusable: []
})

const root: KNode = {
  id: 'root',
  name: 'root',
  parentId: null,
  kind: 'root',
  examWeight: 1,
  prereq: [],
  confusable: []
}

/** 造一条作答记录 */
const rec = (over: Partial<AttemptRecord> & { questionId: string; nodePrimary: string }): AttemptRecord => ({
  id: Math.random().toString(36).slice(2),
  startedAt: NOW - 5000,
  submittedAt: NOW,
  durationMs: 5000,
  correct: true,
  selfConfidence: 'sure',
  guessed: false,
  errorReason: null,
  ...over
})

describe('疑似蒙对：掌握度和热力图必须同一口径', () => {
  const nodes = [root, node('a')]
  const mastery: Record<string, Mastery> = { a: { ...freshMastery(1), n: 3, nok: 3, W: 3, Aw: 3, lastAt: NOW } }
  const questions = [q('q1', 4, [{ nodeId: 'a', weight: 1, primary: true }])]

  it('蒙对的题不计入热力图有效正确率', () => {
    const rows = buildHeatmap({
      nodes,
      questions,
      attempts: [rec({ questionId: 'q1', nodePrimary: 'a', correct: true, guessed: true, durationMs: 1500 })],
      mastery,
      now: NOW,
      daysLeft: 100,
      sort: 'tree'
    })
    const hard = rows.find((r) => r.nodeId === 'a')!.cells.hard
    expect(hard.attempts).toBe(0)
    expect(hard.ratio).toBe(null) // 没有有效答题 → 暂无数据，而不是 100%
    expect(hard.excluded).toBe(1) // 但要记下被剔除了几条
  })

  it('同一份记录下，掌握度不涨、热力图也不涨（不会自相矛盾）', () => {
    const attempts = [rec({ questionId: 'q1', nodePrimary: 'a', correct: true, guessed: true })]
    const rows = buildHeatmap({ nodes, questions, attempts, mastery, now: NOW, daysLeft: 100, sort: 'tree' })
    const row = rows.find((r) => r.nodeId === 'a')!
    expect(row.totalAttempts).toBe(0)
    // 掌握度来自 fixture（3 题全对），没有被这条蒙对改动
    expect(mastery.a.n).toBe(3)
  })

  it('正常答对的题照常计入', () => {
    const rows = buildHeatmap({
      nodes,
      questions,
      attempts: [rec({ questionId: 'q1', nodePrimary: 'a', correct: true, durationMs: 12000 })],
      mastery,
      now: NOW,
      daysLeft: 100,
      sort: 'tree'
    })
    const hard = rows.find((r) => r.nodeId === 'a')!.cells.hard
    expect(hard.attempts).toBe(1)
    expect(hard.ratio).toBe(1)
    expect(summarizeHeat(rows).excluded).toBe(0)
  })
})

describe('作答记录带上全部考点', () => {
  it('一道题挂三个考点，记录里三个都在', () => {
    const question = q('q9', 3, [
      { nodeId: 'a', weight: 1, primary: true },
      { nodeId: 'b', weight: 0.6 },
      { nodeId: 'c', weight: 0.5 }
    ])
    const r = buildAttemptRecord({
      id: 'x',
      question,
      primaryNodeId: 'a',
      correct: false,
      guessed: false,
      durationMs: 9000,
      now: NOW,
      selfConfidence: 'unsure',
      errorReason: 'concept'
    })
    expect(r.tags?.map((t) => t.nodeId)).toEqual(['a', 'b', 'c'])
    expect(r.tags?.find((t) => t.nodeId === 'a')!.primary).toBe(true)
  })

  it('答错时次考点权重打三折，和掌握度更新用的是同一套规则', () => {
    const question = q('q9', 3, [
      { nodeId: 'a', weight: 1, primary: true },
      { nodeId: 'b', weight: 0.6 }
    ])
    const r = buildAttemptRecord({
      id: 'x',
      question,
      primaryNodeId: 'a',
      correct: false,
      guessed: false,
      durationMs: 9000,
      now: NOW,
      selfConfidence: 'sure',
      errorReason: 'concept'
    })
    expect(r.tags?.find((t) => t.nodeId === 'a')!.weight).toBe(1)
    expect(r.tags?.find((t) => t.nodeId === 'b')!.weight).toBeCloseTo(0.18, 5)
  })

  it('老记录没有 tags 时退回主节点，不报错', () => {
    const legacy = rec({ questionId: 'q1', nodePrimary: 'a' })
    expect(nodesOfAttempt(legacy)).toEqual([{ nodeId: 'a', weight: 1, primary: true }])
  })
})

describe('自评与诊断分开表达', () => {
  it('什么都没做 → unmeasured；自评 → self；做过题 → 真实色带', () => {
    expect(evidenceOf(freshMastery(0))).toBe('none')
    expect(band(freshMastery(0), NOW)).toBe('unmeasured')

    expect(evidenceOf(freshMastery(0.5))).toBe('self')
    expect(band(freshMastery(0.5), NOW)).toBe('self')

    const tested: Mastery = { ...freshMastery(1), n: 2, nok: 2, A: 0.9, W: 2, Aw: 1.8, lastAt: NOW }
    expect(evidenceOf(tested)).toBe('tested')
    expect(band(tested, NOW)).toBe('green')
  })

  it('n 和 evidence 字段打架时，以 n 为准（不信任过期字段）', () => {
    const weird: Mastery = { ...freshMastery(1), n: 3, evidence: 'self' }
    expect(evidenceOf(weird)).toBe('tested')
  })

  it('做了题但成绩差 → 就是红色，不能藏在"自评"档里', () => {
    const bad: Mastery = { ...freshMastery(1), n: 4, nok: 0, A: 0.05, W: 4, Aw: 0.2, lastAt: NOW }
    expect(band(bad, NOW)).toBe('red')
  })
})
