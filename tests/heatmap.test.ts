import { describe, expect, it } from 'vitest'
import type { AttemptRecord, KNode, Mastery, Question } from '../src/shared/types'
import { freshMastery } from '../src/shared/mastery'
import { bandOf, buildHeatmap, summarizeHeat } from '../src/main/domain/heatmap'
import { blankMastery } from '../src/main/domain/queue'

const NOW = Date.UTC(2026, 0, 10)

const mkNode = (id: string, parentId: string | null, kind: KNode['kind'] = 'concept'): KNode => ({
  id,
  name: id,
  parentId,
  kind,
  examWeight: 0.5,
  prereq: [],
  confusable: []
})

const root = mkNode('root', null, 'root')
const nodes = [root, mkNode('A', 'root'), mkNode('A1', 'A'), mkNode('A2', 'A')]

const q = (id: string, difficulty: number): Question => ({
  id,
  type: 'judge',
  stem: '',
  answer: 'true',
  difficulty,
  tags: [{ nodeId: 'A1', weight: 1, primary: true }]
})

const questions = [q('q_e', 1), q('q_e2', 2), q('q_m', 3), q('q_h', 4), q('q_h2', 5)]

const attempt = (id: string, questionId: string, nodePrimary: string, correct: boolean): AttemptRecord => ({
  id,
  questionId,
  nodePrimary,
  startedAt: NOW,
  submittedAt: NOW,
  durationMs: 5000,
  correct,
  selfConfidence: 'sure',
  guessed: false,
  errorReason: null
})

const baseArgs = () => ({
  nodes,
  questions,
  attempts: [] as AttemptRecord[],
  mastery: blankMastery(nodes) as Record<string, Mastery>,
  now: NOW,
  daysLeft: 100,
  sort: 'priority' as const
})

describe('难度分桶', () => {
  it('1–2 归易、3 归中、4–5 归难', () => {
    expect(bandOf(1)).toBe('easy')
    expect(bandOf(2)).toBe('easy')
    expect(bandOf(3)).toBe('mid')
    expect(bandOf(4)).toBe('hard')
    expect(bandOf(5)).toBe('hard')
  })
})

describe('热力表', () => {
  it('没做过的格子是 null（不知道），不是 0（全错）', () => {
    const rows = buildHeatmap(baseArgs())
    const a1 = rows.find((r) => r.nodeId === 'A1')!
    expect(a1.cells.easy.ratio).toBeNull()
    expect(a1.cells.easy.attempts).toBe(0)
    expect(a1.mastery).toBeNull()
  })

  it('按难度分别统计正确率', () => {
    const args = baseArgs()
    args.attempts = [
      attempt('1', 'q_e', 'A1', true),
      attempt('2', 'q_e2', 'A1', true),
      attempt('3', 'q_m', 'A1', false),
      attempt('4', 'q_h', 'A1', false)
    ]
    const a1 = buildHeatmap(args).find((r) => r.nodeId === 'A1')!
    expect(a1.cells.easy.attempts).toBe(2)
    expect(a1.cells.easy.ratio).toBe(1)
    expect(a1.cells.mid.ratio).toBe(0)
    expect(a1.cells.hard.ratio).toBe(0)
    expect(a1.totalAttempts).toBe(4)
  })

  it('只认主考点，不会把一次作答算到别的行', () => {
    const args = baseArgs()
    args.attempts = [attempt('1', 'q_e', 'A1', true)]
    const rows = buildHeatmap(args)
    expect(rows.find((r) => r.nodeId === 'A1')!.totalAttempts).toBe(1)
    expect(rows.find((r) => r.nodeId === 'A2')!.totalAttempts).toBe(0)
  })

  it('默认按缺口优先级排序，最差的在最上面', () => {
    const args = baseArgs()
    args.mastery.A1 = { ...freshMastery(1), A: 0.1, n: 3, lastAt: NOW }
    args.mastery.A2 = { ...freshMastery(1), A: 0.9, n: 3, lastAt: NOW }
    const rows = buildHeatmap(args)
    const idxA1 = rows.findIndex((r) => r.nodeId === 'A1')
    const idxA2 = rows.findIndex((r) => r.nodeId === 'A2')
    expect(idxA1).toBeLessThan(idxA2)
  })

  it('结构排序时父在前、子在后', () => {
    const rows = buildHeatmap({ ...baseArgs(), sort: 'tree' })
    const ids = rows.map((r) => r.nodeId)
    expect(ids[0]).toBe('A')
    expect(ids.indexOf('A1')).toBeGreaterThan(ids.indexOf('A'))
  })

  it('不含根节点', () => {
    expect(buildHeatmap(baseArgs()).some((r) => r.nodeId === 'root')).toBe(false)
  })

  it('汇总统计塌了几个、几个没测过', () => {
    const args = baseArgs()
    args.mastery.A1 = { ...freshMastery(1), A: 0.1, n: 3, lastAt: NOW }
    const s = summarizeHeat(buildHeatmap(args))
    expect(s.total).toBe(3)
    expect(s.gaps).toBe(1)
    expect(s.unmeasured).toBe(2)
  })
})
