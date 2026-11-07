import type { AppState, KNode, Mastery, Question, Task } from '../../shared/types'
import { dueUrgency, isDue, retention, freshMastery } from './mastery'
import { questionsForNode, rankGaps } from './priority'

export interface BuildQueueArgs {
  nodes: KNode[]
  questions: Question[]
  mastery: Record<string, Mastery>
  now: number
  dailyMinutes: number
  daysLeft: number
  date: string
}

const REVIEW_MINUTES = 8
const GAP_MINUTES = 13
const MAX_CARDS = 3

/**
 * 今日队列：到期复习 1–2 张 + 缺口补救 1 张（+ 新学 0–1 张，v0.1 不开）。
 * 硬规矩：总时长不超过用户设定，装不下就少给 —— 宁可少给，也不能给到想卸载。
 */
export function buildToday(args: BuildQueueArgs): Task[] {
  const { nodes, questions, mastery, now, dailyMinutes, daysLeft, date } = args
  const tasks: Task[] = []
  const used = new Set<string>()

  /* 1) 到期复习：按遗忘紧急度排序 */
  const due = nodes
    .filter((n) => n.kind !== 'root')
    .map((n) => ({ n, m: mastery[n.id] }))
    .filter((x): x is { n: KNode; m: Mastery } => !!x.m && isDue(x.m, now))
    .sort((a, b) => dueUrgency(b.m, now) - dueUrgency(a.m, now))

  for (const item of due.slice(0, 2)) {
    const qs = questionsForNode(item.n.id, questions).slice(0, 3)
    if (qs.length === 0) continue
    tasks.push({
      id: `${date}-review-${item.n.id}`,
      date,
      kind: 'review',
      nodeId: item.n.id,
      questionIds: qs.map((q) => q.id),
      estMinutes: REVIEW_MINUTES,
      status: 'pending',
      sortOrder: tasks.length
    })
    used.add(item.n.id)
  }

  /* 2) 缺口补救：优先级最高的那个（跳过已排的） */
  const ranked = rankGaps(nodes, mastery, { now, rush: daysLeft <= 30 })
  for (const g of ranked) {
    if (used.has(g.node.id)) continue
    if (g.node.kind === 'root') continue
    const qs = questionsForNode(g.node.id, questions).slice(0, 3)
    if (qs.length === 0) continue
    tasks.push({
      id: `${date}-gap-${g.node.id}`,
      date,
      kind: 'gap',
      nodeId: g.node.id,
      questionIds: qs.map((q) => q.id),
      estMinutes: GAP_MINUTES,
      status: 'pending',
      sortOrder: tasks.length
    })
    used.add(g.node.id)
    break
  }

  /* 3) 预算装箱：超了就砍尾巴 */
  const out: Task[] = []
  let spent = 0
  for (const t of tasks.slice(0, MAX_CARDS)) {
    if (spent + t.estMinutes > dailyMinutes) break
    spent += t.estMinutes
    out.push(t)
  }

  /* 4) 太少就补一个轻动作，避免"今天没事干" */
  if (out.length === 0) {
    const fallback = ranked.find((g) => !used.has(g.node.id) && g.node.kind !== 'root')
    if (fallback) {
      const qs = questionsForNode(fallback.node.id, questions).slice(0, 1)
      if (qs.length) {
        out.push({
          id: `${date}-gap-${fallback.node.id}`,
          date,
          kind: 'gap',
          nodeId: fallback.node.id,
          questionIds: qs.map((q) => q.id),
          estMinutes: 4,
          status: 'pending',
          sortOrder: 0
        })
      }
    }
  }

  return out
}

/** 新建状态时给所有考点铺一层默认掌握（根节点只是容器，不参与评估） */
export function blankMastery(nodes: KNode[]): Record<string, Mastery> {
  const out: Record<string, Mastery> = {}
  for (const n of nodes) out[n.id] = freshMastery(0)
  return out
}

export function coverage(state: AppState, nodes: KNode[]): { measured: number; total: number } {
  const total = nodes.filter((n) => n.kind !== 'root').length
  const measured = nodes.filter((n) => n.kind !== 'root' && (state.mastery[n.id]?.n ?? 0) > 0).length
  return { measured, total }
}

export function daysUntil(examDate: string, now: number): number {
  const t = new Date(examDate + 'T00:00:00').getTime()
  if (Number.isNaN(t)) return 999
  return Math.max(0, Math.round((t - now) / 86_400_000))
}

/** 供界面显示：最近一次保持率，用来解释"为什么它到期了" */
export function retentionOf(m: Mastery, now: number): number {
  return retention(m, now)
}
