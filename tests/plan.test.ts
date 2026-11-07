import { describe, expect, it } from 'vitest'
import type { KNode, Mastery, Question } from '../src/shared/types'
import { freshMastery } from '../src/shared/mastery'
import { gapPriority, rankGaps } from '../src/main/domain/priority'
import { buildToday, blankMastery, daysUntil } from '../src/main/domain/queue'

const NOW = Date.UTC(2026, 0, 10)
const DAY = 86_400_000

const node = (id: string, weight: number, prereq: string[] = []): KNode => ({
  id,
  name: id,
  parentId: 'root',
  kind: 'concept',
  examWeight: weight,
  prereq,
  confusable: []
})

const rootNode: KNode = {
  id: 'root',
  name: 'root',
  parentId: null,
  kind: 'root',
  examWeight: 1,
  prereq: [],
  confusable: []
}

const weak = (): Mastery => ({ ...freshMastery(1), A: 0.15, n: 3, lastAt: NOW - DAY })
const strong = (): Mastery => ({ ...freshMastery(1), A: 0.9, n: 8, lastAt: NOW })

describe('缺口优先级', () => {
  it('同权重下，掌握度低的排前面', () => {
    const a = node('a', 0.8)
    const b = node('b', 0.8)
    const pa = gapPriority(a, weak(), [], { now: NOW, rush: false })
    const pb = gapPriority(b, strong(), [], { now: NOW, rush: false })
    expect(pa).toBeGreaterThan(pb)
  })

  it('前置没打牢时，本篇优先级被压到三成', () => {
    const target = node('t', 0.9, ['p'])
    const open = gapPriority(target, weak(), [0.9], { now: NOW, rush: false })
    const blocked = gapPriority(target, weak(), [0.2], { now: NOW, rush: false })
    expect(blocked).toBeCloseTo(open * 0.35, 5)
  })

  it('考前 30 天进入抢分模式：高权重加权、冷门降权', () => {
    const hot = node('hot', 0.9)
    const cold = node('cold', 0.3)
    const normal = { now: NOW, rush: false }
    const rush = { now: NOW, rush: true }
    const ratioNormal = gapPriority(hot, weak(), [], normal) / gapPriority(cold, weak(), [], normal)
    const ratioRush = gapPriority(hot, weak(), [], rush) / gapPriority(cold, weak(), [], rush)
    expect(ratioRush).toBeGreaterThan(ratioNormal)
  })

  it('错误概念固化会加成', () => {
    const n = node('n', 0.7)
    const plain = gapPriority(n, weak(), [], { now: NOW, rush: false })
    const stuck = gapPriority(n, { ...weak(), misconception: 1 }, [], { now: NOW, rush: false })
    expect(stuck).toBeGreaterThan(plain)
  })

  it('排序结果不含根节点', () => {
    const nodes = [rootNode, node('a', 0.5), node('b', 0.6)]
    const mastery: Record<string, Mastery> = blankMastery(nodes)
    const ranked = rankGaps(nodes, mastery, { now: NOW, rush: false })
    expect(ranked.every((r) => r.node.kind !== 'root')).toBe(true)
    expect(ranked).toHaveLength(2)
  })
})

describe('今日队列', () => {
  const nodes = [rootNode, node('a', 0.9), node('b', 0.8), node('c', 0.7), node('d', 0.6)]
  const questions: Question[] = nodes
    .filter((n) => n.kind !== 'root')
    .flatMap((n, i) =>
      [0, 1, 2].map((k) => ({
        id: `q_${n.id}_${k}`,
        type: 'judge' as const,
        stem: '',
        answer: 'true',
        difficulty: (k as number) + 1,
        tags: [{ nodeId: n.id, weight: 1, primary: true }]
      }))
    )

  it('最多三张卡，且总时长不超过用户上限', () => {
    const mastery: Record<string, Mastery> = blankMastery(nodes)
    mastery.a = weak()
    mastery.b = weak()
    mastery.c = weak()
    mastery.d = weak()
    const tasks = buildToday({
      nodes,
      questions,
      mastery,
      now: NOW,
      dailyMinutes: 15,
      daysLeft: 100,
      date: '2026-01-10'
    })
    expect(tasks.length).toBeLessThanOrEqual(3)
    expect(tasks.reduce((s, t) => s + t.estMinutes, 0)).toBeLessThanOrEqual(15)
  })

  it('没有任何数据时也会给一个轻动作，避免"今天没事干"', () => {
    const mastery: Record<string, Mastery> = blankMastery(nodes)
    const tasks = buildToday({
      nodes,
      questions,
      mastery,
      now: NOW,
      dailyMinutes: 40,
      daysLeft: 100,
      date: '2026-01-10'
    })
    expect(tasks.length).toBeGreaterThan(0)
    expect(tasks[0].questionIds.length).toBeGreaterThan(0)
  })

  it('到期的考点排在最前面', () => {
    const mastery: Record<string, Mastery> = blankMastery(nodes)
    mastery.b = { ...freshMastery(1), A: 0.6, n: 4, lastAt: NOW - 20 * DAY, s: 1 }
    const tasks = buildToday({
      nodes,
      questions,
      mastery,
      now: NOW,
      dailyMinutes: 40,
      daysLeft: 100,
      date: '2026-01-10'
    })
    expect(tasks[0].kind).toBe('review')
    expect(tasks[0].nodeId).toBe('b')
  })

  it('倒计时天数按日期计算', () => {
    expect(daysUntil('2026-01-20', NOW)).toBe(10)
    expect(daysUntil('不是日期', NOW)).toBeGreaterThan(0)
  })
})
