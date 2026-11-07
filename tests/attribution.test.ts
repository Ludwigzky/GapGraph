import { describe, expect, it } from 'vitest'
import type { AttemptRecord, ErrorReason, KNode, Mastery, Question } from '../src/shared/types'
import { applyAttempt, freshMastery, masteryScore } from '../src/shared/mastery'
import {
  attributionLine,
  dominantReason,
  errorBreakdown,
  suggestionFor
} from '../src/main/domain/attribution'
import { blankMastery } from '../src/main/domain/queue'

const NOW = Date.UTC(2026, 0, 10)

const mkNode = (id: string, prereq: string[] = []): KNode => ({
  id,
  name: id,
  parentId: 'root',
  kind: 'concept',
  examWeight: 0.8,
  prereq,
  confusable: []
})

const root = mkNode('root')
const nodes = [root, mkNode('base'), mkNode('target', ['base'])]
const questions: Question[] = []

const attempt = (
  id: string,
  nodePrimary: string,
  correct: boolean,
  errorReason: ErrorReason
): AttemptRecord => ({
  id,
  questionId: 'q',
  nodePrimary,
  startedAt: NOW,
  submittedAt: NOW,
  durationMs: 5000,
  correct,
  selfConfidence: 'sure',
  guessed: false,
  errorReason
})

describe('错因影响掌握度', () => {
  // 起始稳定性设成 10 天：刚学的节点 s=1，会被下限 1 夹住，看不出差别
  const run = (reason: ErrorReason) => {
    let m = { ...freshMastery(1), A: 0.6, s: 10 }
    m = applyAttempt(m, { difficulty: 3, correct: false, weight: 1, sure: true, guessed: false, now: NOW, errorReason: reason })
    return m
  }

  it('「算错了」比「概念不清」扣得少', () => {
    const calc = run('calc')
    const concept = run('concept')
    expect(calc.A).toBeGreaterThan(concept.A)
    expect(masteryScore(calc, NOW)).toBeGreaterThan(masteryScore(concept, NOW))
  })

  it('「算错了」不会把记忆稳定性打崩', () => {
    const calc = run('calc')
    const concept = run('concept')
    expect(calc.s).toBeGreaterThan(concept.s)
  })

  it('「算错了」不会被标成错误概念固化，哪怕你选了"我很确定"', () => {
    expect(run('calc').misconception).toBe(0)
    expect(run('concept').misconception).toBe(1)
  })

  it('不填错因时按默认惩罚处理，介于手滑和概念不清之间', () => {
    const none = run(null)
    const calc = run('calc')
    const concept = run('concept')
    expect(none.A).toBeGreaterThan(concept.A)
    expect(none.A).toBeLessThan(calc.A)
  })
})

describe('错因统计', () => {
  const attempts = [
    attempt('1', 'target', false, 'concept'),
    attempt('2', 'target', false, 'concept'),
    attempt('3', 'target', false, 'calc'),
    attempt('4', 'target', true, null)
  ]

  it('只统计这个考点的错题，且必须是填了原因的', () => {
    const b = errorBreakdown(attempts, 'target')
    expect(b).toEqual([
      { reason: 'concept', count: 2 },
      { reason: 'calc', count: 1 }
    ])
  })

  it('别的考点不串味', () => {
    expect(errorBreakdown(attempts, 'base')).toEqual([])
  })

  it('取出现最多的那个原因', () => {
    expect(dominantReason(attempts, 'target')?.reason).toBe('concept')
  })

  it('没有错题时返回 null', () => {
    expect(dominantReason([], 'target')).toBeNull()
  })
})

describe('错因 → 建议', () => {
  const mastery: Record<string, Mastery> = blankMastery(nodes)
  const target = nodes[2]

  it('概念不清且前置不稳 → 建议先补前置，并给出跳转目标', () => {
    mastery.base = { ...freshMastery(0.5), A: 0.1, n: 3, lastAt: NOW }
    const s = suggestionFor('concept', target, mastery, nodes, NOW)
    expect(s.goto).toBe('base')
    expect(s.text).toContain('base')
  })

  it('前置其实还行 → 不给跳转，建议回看讲解', () => {
    mastery.base = { ...freshMastery(1), A: 0.9, n: 5, lastAt: NOW }
    const s = suggestionFor('concept', target, mastery, nodes, NOW)
    expect(s.goto).toBeUndefined()
  })

  it('算错了不推新题', () => {
    const s = suggestionFor('calc', target, mastery, nodes, NOW)
    expect(s.text).toContain('别刷题')
    expect(s.goto).toBeUndefined()
  })

  it('每种错因都给出不同的文本', () => {
    const reasons = ['calc', 'misread', 'formula', 'method', 'guess'] as const
    const texts = reasons.map((r) => suggestionFor(r, target, mastery, nodes, NOW).text)
    expect(new Set(texts).size).toBe(texts.length)
  })
})

describe('面板归因行', () => {
  it('把众数和次数整理成一句话所需的数据', () => {
    const attempts = [
      attempt('1', 'target', false, 'method'),
      attempt('2', 'target', false, 'method'),
      attempt('3', 'target', false, 'formula')
    ]
    const mastery = blankMastery(nodes)
    const line = attributionLine(nodes[2], attempts, mastery, nodes, NOW)
    expect(line?.label).toBe('方法不会')
    expect(line?.count).toBe(2)
    expect(line?.total).toBe(3)
    expect(line?.suggestion.text.length).toBeGreaterThan(5)
  })

  it('没填过错因就没有这一行', () => {
    expect(attributionLine(nodes[2], [], blankMastery(nodes), nodes, NOW)).toBeNull()
  })
})
