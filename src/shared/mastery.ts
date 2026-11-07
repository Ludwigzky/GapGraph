import type { ErrorReason, Mastery } from './types'

export const DAY = 86_400_000

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

export function freshMastery(K = 0): Mastery {
  return { K, A: 0.3, s: 1, n: 0, nok: 0, misconception: 0, lastAt: null }
}

export function retention(m: Mastery, now: number): number {
  if (!m.lastAt) return 1
  const days = Math.max(0, (now - m.lastAt) / DAY)
  return Math.exp(-days / Math.max(m.s, 0.5))
}

/**
 * 还没做过题时，掌握度直接等于自评档位：
 * 没学过 0（灰）/ 学过不会 0.15（红）/ 会 0.3（橙，待验证）
 * "会"不给到黄绿：绿色应当意味着"做过题证明过"，而不是"自己说会"。
 */
export function selfPrior(K: number): number {
  if (K >= 1) return 0.3
  if (K >= 0.5) return 0.15
  return 0
}

/**
 * 综合掌握度 = 覆盖 × 能力 × 记忆折扣。
 *
 * 关键：记忆保持 R 是"能力"的衰减系数，不是独立加分项。
 * 早先写成 K×(0.6A + 0.4R) 时，刚做完题 R≈1 就白送 0.4，
 * 结果是"连错 5 题正确率 0%，掌握分仍然 0.38 橙色"——全错就该是红的。
 */
export function masteryScore(m: Mastery, now: number): number {
  if (m.n === 0) return selfPrior(m.K)
  const R = retention(m, now)
  const base = m.K * m.A * (0.6 + 0.4 * R)
  return clamp01(m.misconception ? base * 0.85 : base)
}export function confidence(n: number): number {
  return 1 - Math.exp(-n / 4)
}

export function effective(m: Mastery, now: number): { M: number; conf: number; eff: number } {
  const M = masteryScore(m, now)
  const conf = confidence(m.n)
  return { M, conf, eff: conf * M + (1 - conf) * 0.3 }
}

export interface AttemptEffect {
  difficulty: number
  correct: boolean
  weight: number
  sure: boolean
  /** 系统判定疑似蒙对（过快且正确） */
  guessed: boolean
  now: number
  /** 用户在答错后选的错因；决定这次错误该扣多狠 */
  errorReason?: ErrorReason | null
}

/**
 * 不同错因对"能力值"的惩罚系数。
 * 算错了 / 看错题：思路是对的，几乎不该降分；
 * 概念不清：最该降，因为下次照样会错。
 */
const PENALTY: Record<string, number> = {
  calc: 0.2,
  misread: 0.25,
  formula: 0.8,
  method: 0.9,
  concept: 1.0,
  guess: 0.5
}

/** 这几种错是"手滑"，不该让记忆稳定性崩掉 */
const SLIP: Record<string, true> = { calc: true, misread: true }

/**
 * 一次作答对单个考点的更新。
 * 蒙对：不计入证据（n 不变），只刷新接触时间 —— 避免"靠蒙把图刷绿"。
 * 「我很确定但答错」：标记 misconception，掌握度额外打八五折（手滑类不算）。
 */
export function applyAttempt(m: Mastery, e: AttemptEffect): Mastery {
  if (e.guessed && e.correct) {
    return { ...m, lastAt: e.now }
  }

  const days = m.lastAt ? (e.now - m.lastAt) / DAY : 0
  const R = Math.exp(-Math.max(0, days) / Math.max(m.s, 0.5))
  const wDiff = 0.6 + 0.4 * ((e.difficulty - 1) / 4)
  const wRec = Math.exp(-Math.max(0, days) / 14)
  const obs = (e.correct ? 1 : 0) * wDiff

  const penalty = e.correct ? 1 : (PENALTY[e.errorReason ?? ''] ?? 0.8)
  const alpha = 0.35 * clamp01(e.weight) * penalty

  const A = clamp01(m.A + alpha * wRec * (obs - m.A))
  const slip = !e.correct && !!SLIP[e.errorReason ?? '']
  const s = e.correct ? m.s * (1 + 1.2 * (1 - R) * wDiff) : slip ? Math.max(1, m.s * 0.85) : Math.max(1, m.s * 0.45)
  const misconception: 0 | 1 = !e.correct && e.sure && !slip ? 1 : m.misconception

  // 覆盖度不是一次性标签：做对了就该往上抬，否则自评"学过不会"的考点永远封顶在 0.5
  let K = Math.max(m.K, 0.5)
  if (e.correct && A >= 0.6) {
    K = Math.min(1, Math.round((K + 0.2) * 100) / 100)
  }

  return {
    ...m,
    K,
    A,
    s,
    n: m.n + 1,
    nok: m.nok + (e.correct ? 1 : 0),
    misconception,
    lastAt: e.now
  }
}

export function isDue(m: Mastery, now: number): boolean {
  if (!m.lastAt || m.n === 0) return false
  return retention(m, now) < 0.7
}

export function dueUrgency(m: Mastery, now: number): number {
  return (0.7 - retention(m, now)) / 0.7
}

export type Band = 'red' | 'orange' | 'yellow' | 'green' | 'unmeasured'

/** 五档色带。判据是"有没有任何信息"：自评过（K>0）就该有颜色，不必等做题 */
export function band(m: Mastery, now: number): Band {
  if (m.n === 0 && m.K === 0) return 'unmeasured'
  const M = masteryScore(m, now)
  if (M < 0.25) return 'red'
  if (M < 0.4) return 'orange'
  if (M < 0.6) return 'yellow'
  return 'green'
}
