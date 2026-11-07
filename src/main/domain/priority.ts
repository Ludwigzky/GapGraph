import type { KNode, Mastery, Question } from '../../shared/types'
import { effective } from './mastery'

export interface RiskOptions {
  now: number
  /** 考前 30 天开启抢分模式：高权重考点加权，冷门降权 */
  rush: boolean
}

/**
 * 这个考点该被怎么处理。排序方必须自己决定未知怎么办，
 * 不能再靠"把未知折算成 0.3 分"来蒙混过去。
 * - diagnose：没有有效证据（或只有自评），应该先测一测
 * - weak     ：测过，确实薄弱
 * - practice ：测过，部分掌握，需要针对性练习
 * - solid    ：测过且比较稳，可以不排
 */
export type GapReason = 'diagnose' | 'weak' | 'practice' | 'solid'

export interface RankedGap {
  node: KNode
  priority: number
  eff: number
  /** 有没有真实答题证据 */
  known: boolean
  conf: number
  reason: GapReason
}

/** 未知节点的诊断价值：只跟重要性和前置阻断挂钩，**不假装它薄弱** */
const DIAGNOSE_BASE = 0.55

export function reasonOf(known: boolean, eff: number): GapReason {
  if (!known) return 'diagnose'
  if (eff < 0.4) return 'weak'
  if (eff < 0.7) return 'practice'
  return 'solid'
}

/**
 * 缺口优先级。
 *
 * v2 起分两种算法，因为它们回答的是两个不同的问题：
 *
 *   已测节点：P = 重要性 × (1 − 能力) × 前置闸门 × 错误概念加成 × 抢分系数
 *             —— 问的是"这里有个洞，多大、多急"
 *
 *   未知节点：P = 重要性 × 诊断基数 × 前置闸门 × 抢分系数
 *             —— 问的是"这里还没测过，值不值得先测一下"
 *
 * 旧版本把未知折算成 eff=0.3 再套 (1−eff)=0.7，等于**默认它薄**，
 * 于是没测过的考点会长期压着真正测出来的漏洞。这正是任务书 B5 第③条要修的。
 */
export function gapPriority(
  node: KNode,
  m: Mastery,
  prereqEffs: number[],
  opts: RiskOptions
): number {
  const e = effective(m, opts.now)
  const depGate = prereqEffs.length === 0 ? 1 : prereqEffs.every((x) => x >= 0.6) ? 1 : 0.35
  const misc = m.misconception ? 1.3 : 1
  const mode = opts.rush ? (node.examWeight >= 0.7 ? 1.4 : 0.6) : 1
  const gap = e.known ? 1 - e.eff : DIAGNOSE_BASE
  return node.examWeight * gap * depGate * misc * mode
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
          return pm ? effective(pm, opts.now).eff : 0.5
        })
      const e = effective(m, opts.now)
      return {
        node: n,
        priority: gapPriority(n, m, prereqEffs, opts),
        eff: e.eff,
        known: e.known,
        conf: e.conf,
        reason: reasonOf(e.known, e.eff)
      }
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
