import type { KNode, Mastery, Question } from '../../shared/types'
import { effective } from './mastery'

export interface RiskOptions {
  now: number
  /** 考前 30 天开启抢分模式：高权重考点加权，冷门降权 */
  rush: boolean
}

/**
 * 缺口优先级 P = 考频权重 ×(1−掌握度)× 前置闸门 × 错误概念加成 × 抢分系数
 * 前置闸门是"先修地基"的体现：前置没打牢，本篇再红也先压一压。
 */
export function gapPriority(
  node: KNode,
  m: Mastery,
  prereqEffs: number[],
  opts: RiskOptions
): number {
  const { eff } = effective(m, opts.now)
  const depGate = prereqEffs.length === 0 ? 1 : prereqEffs.every((x) => x >= 0.6) ? 1 : 0.35
  const misc = m.misconception ? 1.3 : 1
  const mode = opts.rush ? (node.examWeight >= 0.7 ? 1.4 : 0.6) : 1
  return node.examWeight * (1 - eff) * depGate * misc * mode
}

export interface RankedGap {
  node: KNode
  priority: number
  eff: number
}

export function rankGaps(
  nodes: KNode[],
  mastery: Record<string, Mastery>,
  opts: RiskOptions
): RankedGap[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return nodes
    .filter((n) => n.kind !== 'root')
    .map((n) => {
      const m = mastery[n.id]
      if (!m) return null
      const prereqEffs = n.prereq
        .map((id) => byId.get(id))
        .filter((p): p is KNode => !!p)
        .map((p) => {
          const pm = mastery[p.id]
          return pm ? effective(pm, opts.now).eff : 0.3
        })
      return { node: n, priority: gapPriority(n, m, prereqEffs, opts), eff: effective(m, opts.now).eff }
    })
    .filter((x): x is RankedGap => !!x)
    .sort((a, b) => b.priority - a.priority)
}

/** 一个考点可用的题目：优先主考点，其次次考点 */
export function questionsForNode(nodeId: string, questions: Question[]): Question[] {
  const primary = questions.filter((q) => q.tags.some((t) => t.nodeId === nodeId && t.primary))
  const secondary = questions.filter(
    (q) => !primary.includes(q) && q.tags.some((t) => t.nodeId === nodeId)
  )
  return [...primary, ...secondary].sort((a, b) => a.difficulty - b.difficulty)
}
