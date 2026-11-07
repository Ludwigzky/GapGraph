import type { KNode, Mastery, Question } from '../../shared/types'
import { band, masteryScore } from '../../shared/mastery'

/** 摸底的目标题量：12–15 题，超过就停 */
export const DIAG_TARGET = 15
/** 少于这个数不做结论 */
export const DIAG_MIN = 6

export interface DiagState {
  askedIds: string[]
  answered: { questionId: string; nodeId: string; correct: boolean }[]
  /** 下一题想考的难度，答对加一、答错减一 */
  targetDifficulty: number
}

export function createDiagnostic(): DiagState {
  return { askedIds: [], answered: [], targetDifficulty: 2 }
}

export function primaryNodeOf(q: Question): string | null {
  const t = q.tags.find((x) => x.primary) ?? q.tags[0]
  return t?.nodeId ?? null
}

/**
 * 挑下一题：
 * 1) 优先覆盖还没测过的考点（摸底的意义在于"铺开"，不是"刷满一个点"）
 * 2) 上一题答错了，就往它的前置考点下钻 —— 这是"你错在根上"的来源
 * 3) 难度向 targetDifficulty 收敛
 */
export function nextQuestion(
  state: DiagState,
  questions: Question[],
  nodes: KNode[],
  mastery: Record<string, Mastery>
): Question | null {
  if (state.askedIds.length >= DIAG_TARGET) return null

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const covered = new Set(state.answered.map((a) => a.nodeId))
  const lastWrong = [...state.answered].reverse().find((a) => !a.correct)
  const drill = new Set(lastWrong ? (byId.get(lastWrong.nodeId)?.prereq ?? []) : [])

  let best: { q: Question; score: number } | null = null
  for (const q of questions) {
    if (state.askedIds.includes(q.id)) continue
    const nodeId = primaryNodeOf(q)
    if (!nodeId) continue
    const node = byId.get(nodeId)
    if (!node) continue

    let score = 0
    if (!covered.has(nodeId)) score += 3
    if (drill.has(nodeId)) score += 4
    score += 2 * node.examWeight
    score -= 1.6 * Math.abs(q.difficulty - state.targetDifficulty)
    const m = mastery[nodeId]
    if (m && m.n >= 2) score -= 2

    if (!best || score > best.score) best = { q, score }
  }
  return best?.q ?? null
}

export function applyDiagAnswer(
  state: DiagState,
  questionId: string,
  nodeId: string,
  correct: boolean
): DiagState {
  return {
    askedIds: [...state.askedIds, questionId],
    answered: [...state.answered, { questionId, nodeId, correct }],
    targetDifficulty: correct
      ? Math.min(5, state.targetDifficulty + 1)
      : Math.max(1, state.targetDifficulty - 1)
  }
}

export interface DiagSummary {
  answered: number
  touched: number
  bands: { red: number; orange: number; yellow: number; green: number }
  weakest: { id: string; name: string; score: number }[]
}

/** 摸底结果：只说三件事 —— 测了多少、塌了几处、最薄的是谁 */
export function summarize(
  state: DiagState,
  nodes: KNode[],
  mastery: Record<string, Mastery>,
  now: number
): DiagSummary {
  const touchedIds = [...new Set(state.answered.map((a) => a.nodeId))]
  const bands = { red: 0, orange: 0, yellow: 0, green: 0 }
  const scored: { id: string; name: string; score: number }[] = []

  for (const id of touchedIds) {
    const m = mastery[id]
    if (!m || m.n === 0) continue
    const b = band(m, now)
    if (b !== 'unmeasured') bands[b] += 1
    scored.push({ id, name: nodes.find((n) => n.id === id)?.name ?? id, score: masteryScore(m, now) })
  }

  scored.sort((a, b) => a.score - b.score)

  return {
    answered: state.answered.length,
    touched: touchedIds.length,
    bands,
    weakest: scored.slice(0, 3)
  }
}
