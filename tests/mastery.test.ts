import { describe, expect, it } from 'vitest'
import {
  DAY,
  applyAttempt,
  band,
  confidence,
  effective,
  freshMastery,
  isDue,
  masteryScore,
  retention
} from '../src/shared/mastery'
import { isCorrect, normalize } from '../src/main/domain/grading'
import type { Question } from '../src/shared/types'

const T0 = Date.UTC(2026, 0, 1)

describe('掌握度模型', () => {
  it('没学过就是 0 分，不猜', () => {
    const m = freshMastery(0)
    expect(masteryScore(m, T0)).toBe(0)
    expect(confidence(0)).toBe(0)
  })

  it('自评"会"只是初值，不直接算稳', () => {
    const m = freshMastery(1)
    const scored = masteryScore(m, T0)
    expect(scored).toBeGreaterThan(0.2)
    expect(scored).toBeLessThan(0.4)
    // 自评还没被答题验证：单独一档，不能被当成"已测"来展示
    expect(band(m, T0)).toBe('self')
  })

  it('连续答对难题会涨分，连续答错会掉分', () => {
    let good = { ...freshMastery(1), A: 0.5 }
    for (let i = 0; i < 4; i++) {
      good = applyAttempt(good, { difficulty: 4, correct: true, weight: 1, sure: true, guessed: false, now: T0 + i * DAY })
    }
    let bad = { ...freshMastery(1), A: 0.5 }
    for (let i = 0; i < 4; i++) {
      bad = applyAttempt(bad, { difficulty: 4, correct: false, weight: 1, sure: true, guessed: false, now: T0 + i * DAY })
    }
    expect(masteryScore(good, T0 + 4 * DAY)).toBeGreaterThan(masteryScore(bad, T0 + 4 * DAY))
  })

  it('"我很确定但答错"会标记错误概念固化并额外降分', () => {
    const base = { ...freshMastery(1), A: 0.7 }
    const m = applyAttempt(base, { difficulty: 3, correct: false, weight: 1, sure: true, guessed: false, now: T0 })
    expect(m.misconception).toBe(1)
    const unsure = applyAttempt(base, { difficulty: 3, correct: false, weight: 1, sure: false, guessed: false, now: T0 })
    expect(unsure.misconception).toBe(0)
    expect(masteryScore(m, T0)).toBeLessThan(masteryScore(unsure, T0))
  })

  it('蒙对不计入证据：做题次数和掌握度都不变', () => {
    const base = { ...freshMastery(1), A: 0.2 }
    const m = applyAttempt(base, { difficulty: 3, correct: true, weight: 1, sure: false, guessed: true, now: T0 })
    expect(m.n).toBe(0)
    expect(m.A).toBe(0.2)
  })

  it('记忆会遗忘，稳定性高时忘得慢', () => {
    const m = { ...freshMastery(1), A: 0.8, s: 1, lastAt: T0 }
    expect(retention(m, T0 + 30 * DAY)).toBeLessThan(0.1)
    const stable = { ...m, s: 30 }
    expect(retention(stable, T0 + 30 * DAY)).toBeGreaterThan(0.3)
  })

  it('到期判定只在做过题之后成立', () => {
    const never = freshMastery(0)
    expect(isDue(never, T0)).toBe(false)
    const stale = { ...freshMastery(1), n: 3, lastAt: T0 - 10 * DAY, s: 1 }
    expect(isDue(stale, T0)).toBe(true)
  })

  it('数据少时向 0.3 先验收缩，避免排错任务', () => {
    const few = { ...freshMastery(1), A: 0.9, n: 1, lastAt: T0 }
    const eff = effective(few, T0)
    expect(eff.conf).toBeLessThan(0.3)
    expect(eff.eff).toBeLessThan(eff.M)
  })

  it('自评"学过不会"的考点，连续做对能真的走到绿色（不能被 K 封顶）', () => {
    let m = { ...freshMastery(0.5), A: 0.3 }
    // 还没做题：是"自评待验证"，不是"已测薄弱"
    expect(band(m, T0)).toBe('self')
    for (let i = 1; i <= 4; i++) {
      m = applyAttempt(m, {
        difficulty: 3,
        correct: true,
        weight: 1,
        sure: true,
        guessed: false,
        now: T0 + i * DAY
      })
    }
    expect(band(m, T0 + 4 * DAY)).toBe('green')
    expect(m.K).toBeGreaterThan(0.5)
  })

  it('自评之后立刻有状态，但标记为"自评待验证"，不冒充诊断结论', () => {
    expect(band(freshMastery(0), T0)).toBe('unmeasured')
    expect(band(freshMastery(0.5), T0)).toBe('self')
    expect(band(freshMastery(1), T0)).toBe('self')
  })

  it('连续答错必须掉到红色 —— 正确率 0% 不能显示成"还行"', () => {
    let m = { ...freshMastery(1), A: 0.6 }
    for (let i = 1; i <= 4; i++) {
      m = applyAttempt(m, {
        difficulty: 3,
        correct: false,
        weight: 1,
        sure: true,
        guessed: false,
        now: T0 + i * 60_000
      })
    }
    expect(band(m, T0 + 4 * 60_000)).toBe('red')
  })

  it('答错不会把"学过"这件事倒退回去', () => {
    const learned = { ...freshMastery(1), A: 0.8, n: 5, lastAt: T0 }
    const after = applyAttempt(learned, {
      difficulty: 3,
      correct: false,
      weight: 1,
      sure: false,
      guessed: false,
      now: T0 + DAY
    })
    expect(after.K).toBe(1)
  })
})

describe('时间衰减：能力值反映"现在"，不是"历史平均"', () => {
  const hit = (m: ReturnType<typeof freshMastery>, correct: boolean, now: number) =>
    applyAttempt(m, { difficulty: 3, correct, weight: 1, sure: false, guessed: false, now, errorReason: null })

  /** 70 道错题，然后隔一阵 30 道对题 → 应该认得出在进步 */
  it('先错后对：最近的对题能把能力值拉起来', () => {
    let m = freshMastery(1)
    for (let i = 0; i < 70; i++) m = hit(m, false, T0 + i * DAY)
    for (let i = 0; i < 30; i++) m = hit(m, true, T0 + 100 * DAY + i * DAY)
    expect(m.A).toBeGreaterThan(0.6)
    expect(masteryScore(m, T0 + 130 * DAY)).toBeGreaterThan(0.45)
  })

  /** 同样 30 对 70 错，但对题在前面 → 现在应该很差 */
  it('先对后错：早期的对题救不了当前状态', () => {
    let m = freshMastery(1)
    for (let i = 0; i < 30; i++) m = hit(m, true, T0 + i * DAY)
    for (let i = 0; i < 70; i++) m = hit(m, false, T0 + 100 * DAY + i * DAY)
    expect(m.A).toBeLessThan(0.35)
  })

  it('同样的对错总数，顺序不同结果必须不同（旧的固定步长模型区分不出来）', () => {
    let up = freshMastery(1)
    for (let i = 0; i < 60; i++) up = hit(up, i < 40, T0 + i * DAY)
    for (let i = 0; i < 20; i++) up = hit(up, true, T0 + 70 * DAY + i * DAY)

    let down = freshMastery(1)
    for (let i = 0; i < 20; i++) down = hit(down, true, T0 + i * DAY)
    for (let i = 0; i < 60; i++) down = hit(down, i < 40, T0 + 70 * DAY + i * DAY)

    expect(up.A).toBeGreaterThan(down.A + 0.2)
  })

  it('同一天内先错后对，也能识别出"刚才是不会，现在会了"', () => {
    let m = freshMastery(1)
    for (let i = 0; i < 20; i++) m = hit(m, false, T0 + i * 60_000)
    const afterWrong = m.A
    for (let i = 0; i < 20; i++) m = hit(m, true, T0 + (30 + i) * 60_000)
    expect(afterWrong).toBeLessThan(0.3)
    expect(m.A).toBeGreaterThan(0.6)
  })

  it('一次失误不会把能力值打到 0（有先验兜着）', () => {
    const m = hit(freshMastery(1), false, T0)
    expect(m.A).toBeGreaterThan(0.1)
    expect(m.A).toBeLessThan(0.3)
  })

  it('久不练习：有效证据量衰减，置信度跟着回落', () => {
    let m = freshMastery(1)
    for (let i = 0; i < 20; i++) m = hit(m, true, T0 + i * DAY)
    const fresh = effective(m, T0 + 20 * DAY).conf
    const stale = effective(m, T0 + 20 * DAY + 120 * DAY).conf
    expect(fresh).toBeGreaterThan(0.75)
    expect(stale).toBeLessThan(fresh - 0.3)
  })
})

describe('判分', () => {
  const q = (answer: string[], type: Question['type'] = 'blank'): Question => ({
    id: 't',
    type,
    stem: '',
    answer,
    difficulty: 3,
    tags: [{ nodeId: 'x', weight: 1, primary: true }]
  })

  it('分数与小数等价', () => {
    expect(isCorrect(q(['3/2']), '1.5')).toBe(true)
    expect(isCorrect(q(['1.5']), '3/2')).toBe(true)
  })

  it('不等号与全角符号归一化', () => {
    expect(normalize('x≥−3')).toBe('x>=-3')
    expect(isCorrect(q(['x>=-3']), 'x≥−3')).toBe(true)
  })

  it('空答案不算对', () => {
    expect(isCorrect(q(['1']), '  ')).toBe(false)
  })

  it('判断题只认 true/false', () => {
    expect(isCorrect(q(['true'], 'judge'), 'true')).toBe(true)
    expect(isCorrect(q(['true'], 'judge'), 'false')).toBe(false)
  })
})
