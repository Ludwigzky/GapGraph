import type { AttemptRecord, ErrorReason, KNode, Mastery } from '../../shared/types'
import { effective, masteryScore } from '../../shared/mastery'

/** 错因的唯一列表，界面按这个顺序排按钮 */
export const REASONS: { key: Exclude<ErrorReason, null>; label: string; hint: string }[] = [
  { key: 'calc', label: '算错了', hint: '思路对，只是手滑' },
  { key: 'misread', label: '看错题', hint: '漏了条件或看串了' },
  { key: 'formula', label: '公式记错', hint: '用错了公式/定理' },
  { key: 'concept', label: '概念不清', hint: '这个点本身没搞明白' },
  { key: 'method', label: '方法不会', hint: '不知道该用哪套办法' },
  { key: 'guess', label: '蒙的', hint: '基本靠猜' }
]

export const REASON_LABEL: Record<string, string> = Object.fromEntries(
  REASONS.map((r) => [r.key, r.label])
)

export interface ReasonCount {
  reason: Exclude<ErrorReason, null>
  count: number
}

/** 某个考点上，错因各出现过几次（只看错题，且用户填了原因） */
export function errorBreakdown(attempts: AttemptRecord[], nodeId: string): ReasonCount[] {
  const acc = new Map<Exclude<ErrorReason, null>, number>()
  for (const a of attempts) {
    if (a.nodePrimary !== nodeId || a.correct || !a.errorReason) continue
    const r = a.errorReason as Exclude<ErrorReason, null>
    acc.set(r, (acc.get(r) ?? 0) + 1)
  }
  return [...acc.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
}

export function dominantReason(attempts: AttemptRecord[], nodeId: string): ReasonCount | null {
  return errorBreakdown(attempts, nodeId)[0] ?? null
}

export interface Suggestion {
  text: string
  /** 建议先去看哪个考点（点一下跳过去） */
  goto?: string
}

/**
 * 错因 → 下一步动作。这是"归因"真正的价值：
 * 同样是错，算错和概念不清要吃完全不同的药。
 */
export function suggestionFor(
  reason: Exclude<ErrorReason, null>,
  node: KNode,
  mastery: Record<string, Mastery>,
  nodes: KNode[],
  now: number
): Suggestion {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const weakPre = node.prereq
    .map((id) => ({ id, eff: effective(mastery[id] ?? { K: 0, A: 0.3, s: 1, n: 0, nok: 0, misconception: 0, lastAt: null }, now).eff }))
    .sort((a, b) => a.eff - b.eff)[0]
  const preName = weakPre ? (byId.get(weakPre.id)?.name ?? weakPre.id) : ''

  switch (reason) {
    case 'calc':
      return { text: '思路是对的，别刷题，下次把计算步骤写全、回头验算一遍。' }
    case 'misread':
      return { text: '读题时先把关键词圈出来（「至少」「非负」「整数」），再动笔。' }
    case 'formula':
      return { text: '把这个公式和它的适用条件单独记一张卡，明天再自测一次。' }
    case 'method':
      return { text: '这是"方法不会"，需要先看一遍标准解法的步骤模板，再练两道同类题。' }
    case 'guess':
      return { text: '这次基本靠猜，五天后会再考你一遍，别急着标记为掌握。' }
    case 'concept':
    default:
      if (weakPre && weakPre.eff < 0.6) {
        return { text: `这个考点本身没打牢，而且它依赖的「${preName}」你也不稳——先补那一块。`, goto: weakPre.id }
      }
      return { text: '这个考点本身没打牢，建议回看讲解，然后从最简单的题重新做起。' }
  }
}

/** 面板用：一句话总结这个考点"主要错在哪" */
export function attributionLine(
  node: KNode,
  attempts: AttemptRecord[],
  mastery: Record<string, Mastery>,
  nodes: KNode[],
  now: number
): { reason: Exclude<ErrorReason, null>; label: string; count: number; total: number; suggestion: Suggestion } | null {
  const dom = dominantReason(attempts, node.id)
  if (!dom) return null
  const total = errorBreakdown(attempts, node.id).reduce((s, r) => s + r.count, 0)
  return {
    reason: dom.reason,
    label: REASON_LABEL[dom.reason] ?? dom.reason,
    count: dom.count,
    total,
    suggestion: suggestionFor(dom.reason, node, mastery, nodes, now)
  }
}

/** 掌握度分档的辅助：给热力表/面板判断"是不是缺口" */
export function isGap(m: Mastery, now: number): boolean {
  return masteryScore(m, now) < 0.4
}
