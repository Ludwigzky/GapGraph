import { describe, expect, it } from 'vitest'
import type { AttemptRecord, KNode, Mastery, Question } from '../src/shared/types'
import { applyAttempt, freshMastery, isDue, masteryScore } from '../src/shared/mastery'
import { buildToday, blankMastery } from '../src/main/domain/queue'
import { gapPriority } from '../src/main/domain/priority'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 1)

const mkNode = (id: string, weight: number): KNode => ({
  id,
  name: id,
  parentId: 'root',
  kind: 'concept',
  examWeight: weight,
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

const nodes = [root, mkNode('hot', 0.9), mkNode('cold', 0.3)]

const qs = (nodeId: string): Question[] =>
  [1, 2, 3].map((d) => ({
    id: `q_${nodeId}_${d}`,
    type: 'judge' as const,
    stem: '',
    answer: 'true',
    difficulty: d,
    tags: [{ nodeId, weight: 1, primary: true }]
  }))

const questions = [...qs('hot'), ...qs('cold')]

/** 模拟：在某一天连续做对 n 题 */
function practice(times: number, at: number, difficulty = 3): Mastery {
  let m = { ...freshMastery(1), A: 0.3 }
  for (let i = 0; i < times; i++) {
    m = applyAttempt(m, {
      difficulty,
      correct: true,
      weight: 1,
      sure: true,
      guessed: false,
      now: at + i * 1000
    })
  }
  return m
}

describe('时间流逝：到期复习', () => {
  it('当天做完不会立刻"到期"', () => {
    const m = practice(3, T0)
    expect(isDue(m, T0 + 1000)).toBe(false)
  })

  it('隔一天就会进入到期复习队列，并且排在今日队列第一位', () => {
    const mastery: Record<string, Mastery> = blankMastery(nodes)
    mastery.hot = practice(3, T0 - 2 * DAY)
    mastery.cold = { ...freshMastery(0.5), A: 0.2, n: 3, lastAt: T0 - 2 * DAY }

    const today = T0 + 3 * DAY
    const tasks = buildToday({
      nodes,
      questions,
      mastery,
      now: today,
      dailyMinutes: 40,
      daysLeft: 100,
      date: '2026-01-04'
    })

    expect(tasks[0].kind).toBe('review')
    expect(tasks.some((t) => t.kind === 'review')).toBe(true)
  })

  it('久不复习：能力分不贬损，但复习紧迫度显著上升', () => {
    // v2：时间流逝影响的是"该复习了"，不是"变笨了"。
    // 以前 M = K·A·(0.6+0.4R) 会让分数随遗忘曲线掉，等于把没复习当成能力下降。
    const m = practice(3, T0)
    const fresh = masteryScore(m, T0 + 1000)
    const stale = masteryScore(m, T0 + 30 * DAY)
    expect(stale).toBeCloseTo(fresh, 10) // 能力不变
    expect(isDue(m, T0 + 30 * DAY)).toBe(true) // 但会被排进复习
  })

  it('连续几天不碰，进度不会自己涨回去', () => {
    const m = practice(3, T0)
    const d7 = masteryScore(m, T0 + 7 * DAY)
    const d14 = masteryScore(m, T0 + 14 * DAY)
    expect(d14).toBeLessThanOrEqual(d7)
  })
})

describe('时间流逝：抢分模式', () => {
  const weak = (): Mastery => ({ ...freshMastery(0.5), A: 0.15, n: 3, lastAt: T0 - DAY })

  it('考前 30 天内，高权重考点被抬起来', () => {
    const normal = { now: T0, rush: false }
    const rush = { now: T0, rush: true }
    const hot = nodes[1]
    const cold = nodes[2]

    const ratioNormal = gapPriority(hot, weak(), [], normal) / gapPriority(cold, weak(), [], normal)
    const ratioRush = gapPriority(hot, weak(), [], rush) / gapPriority(cold, weak(), [], rush)
    expect(ratioRush).toBeGreaterThan(ratioNormal)
  })

  it('剩余天数由调用方决定，队列据此切换模式', () => {
    const mastery: Record<string, Mastery> = blankMastery(nodes)
    mastery.hot = weak()
    mastery.cold = weak()

    const early = buildToday({
      nodes,
      questions,
      mastery,
      now: T0,
      dailyMinutes: 40,
      daysLeft: 200,
      date: '2026-01-01'
    })
    const late = buildToday({
      nodes,
      questions,
      mastery,
      now: T0,
      dailyMinutes: 40,
      daysLeft: 10,
      date: '2026-01-01'
    })
    expect(early.length).toBeGreaterThan(0)
    expect(late.length).toBeGreaterThan(0)
    expect(late[0].nodeId).toBe('hot')
  })
})

describe('时间流逝：预算仍然生效', () => {
  it('时长设成 20 分钟时不会硬塞两张卡（8+13 超预算）', () => {
    const mastery: Record<string, Mastery> = blankMastery(nodes)
    mastery.hot = practice(3, T0 - 3 * DAY)
    mastery.cold = { ...freshMastery(0.5), A: 0.2, n: 3, lastAt: T0 - 3 * DAY }

    const tasks = buildToday({
      nodes,
      questions,
      mastery,
      now: T0 + 4 * DAY,
      dailyMinutes: 20,
      daysLeft: 100,
      date: '2026-01-05'
    })
    const spent = tasks.reduce((s, t) => s + t.estMinutes, 0)
    expect(spent).toBeLessThanOrEqual(20)
  })
})

describe('模拟一次完整的 7 天使用', () => {
  it('每天都有活干，且缺口总体在收敛', () => {
    let mastery: Record<string, Mastery> = blankMastery(nodes)
    const daysWithWork: number[] = []
    const gaps: number[] = []

    for (let d = 0; d < 7; d++) {
      const now = T0 + d * DAY
      const tasks = buildToday({
        nodes,
        questions,
        mastery,
        now,
        dailyMinutes: 40,
        daysLeft: 100 - d,
        date: `2026-01-0${d + 1}`
      })
      daysWithWork.push(tasks.length)

      // 把当天每张卡的题做对
      for (const t of tasks) {
        for (const _ of t.questionIds) {
          mastery[t.nodeId] = applyAttempt(mastery[t.nodeId] ?? freshMastery(1), {
            difficulty: 3,
            correct: true,
            weight: 1,
            sure: true,
            guessed: false,
            now
          })
        }
      }
      gaps.push(
        nodes
          .filter((n) => n.kind !== 'root')
          .filter((n) => masteryScore(mastery[n.id] ?? freshMastery(0), now) < 0.4).length
      )
    }

    // 每天都排得出任务（不会出现"今天没事干"）
    expect(daysWithWork.every((n) => n > 0)).toBe(true)
    // 缺口数不上升
    expect(gaps[6]).toBeLessThanOrEqual(gaps[0])
  })
})
