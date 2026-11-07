import type { AttemptRecord, KNode, Mastery, Question } from '../../shared/types'
import { effective } from '../../shared/mastery'
import { rankGaps } from './priority'

/** 难度分层：易（1–2）/ 中（3）/ 难（4–5），对应高考 5:3:2 的分数结构 */
export const BANDS = [
  { key: 'easy', label: '易', hint: '难度 1–2' },
  { key: 'mid', label: '中', hint: '难度 3' },
  { key: 'hard', label: '难', hint: '难度 4–5' }
] as const

export type BandKey = (typeof BANDS)[number]['key']

export function bandOf(difficulty: number): BandKey {
  if (difficulty <= 2) return 'easy'
  if (difficulty === 3) return 'mid'
  return 'hard'
}

export interface Cell {
  attempts: number
  correct: number
  /** null 表示这道难度还没做过 —— 是"不知道"，不是"全错" */
  ratio: number | null
  /** 疑似蒙对、被排除在有效统计之外的条数（和掌握度口径保持一致） */
  excluded: number
}

export interface HeatRow {
  nodeId: string
  name: string
  /** 上一级板块名，用来在平铺列表里标出处 */
  parentName: string
  depth: number
  cells: Record<BandKey, Cell>
  /** 掌握分，没测过为 null */
  mastery: number | null
  conf: number
  priority: number
  totalAttempts: number
}

export interface HeatmapArgs {
  nodes: KNode[]
  questions: Question[]
  attempts: AttemptRecord[]
  mastery: Record<string, Mastery>
  now: number
  daysLeft: number
  sort: 'priority' | 'tree'
}

const emptyCells = (): Record<BandKey, Cell> => ({
  easy: { attempts: 0, correct: 0, ratio: null, excluded: 0 },
  mid: { attempts: 0, correct: 0, ratio: null, excluded: 0 },
  hard: { attempts: 0, correct: 0, ratio: null, excluded: 0 }
})

function treeOrder(nodes: KNode[]): string[] {
  const kids = new Map<string, KNode[]>()
  let rootId = ''
  for (const n of nodes) {
    if (!n.parentId) {
      rootId = n.id
      continue
    }
    const list = kids.get(n.parentId) ?? []
    list.push(n)
    kids.set(n.parentId, list)
  }
  const out: string[] = []
  const walk = (id: string): void => {
    out.push(id)
    for (const k of kids.get(id) ?? []) walk(k.id)
  }
  if (rootId) walk(rootId)
  return out
}

/**
 * 逐考点 × 难度统计做题结果。
 * 只认 attempt.nodePrimary（一道题的主考点），避免把综合题算到五六个格子里。
 */
export function buildHeatmap(args: HeatmapArgs): HeatRow[] {
  const { nodes, questions, attempts, mastery, now, daysLeft, sort } = args

  const qById = new Map(questions.map((q) => [q.id, q]))
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const acc = new Map<string, Record<BandKey, Cell>>()

  for (const a of attempts) {
    const q = qById.get(a.questionId)
    if (!q) continue
    const node = nodeById.get(a.nodePrimary)
    if (!node) continue
    const bucket = acc.get(a.nodePrimary) ?? emptyCells()
    const cell = bucket[bandOf(q.difficulty)]
    // 疑似蒙对：掌握度那边直接跳过（见 applyAttempt），
    // 热力图也必须跳过，否则会出现"分数没涨、正确率却涨了"的自相矛盾。
    if (a.guessed && a.correct) {
      cell.excluded += 1
      acc.set(a.nodePrimary, bucket)
      continue
    }
    cell.attempts += 1
    if (a.correct) cell.correct += 1
    acc.set(a.nodePrimary, bucket)
  }

  const priorityOf = new Map(
    rankGaps(nodes, mastery, { now, rush: daysLeft <= 30 }).map((g) => [g.node.id, g.priority])
  )

  const rows: HeatRow[] = nodes
    .filter((n) => n.kind !== 'root')
    .map((n) => {
      const cells = acc.get(n.id) ?? emptyCells()
      for (const b of BANDS) {
        const c = cells[b.key]
        c.ratio = c.attempts === 0 ? null : c.correct / c.attempts
      }
      const m = mastery[n.id]
      const eff = effective(m ?? { K: 0, A: 0.3, s: 1, n: 0, nok: 0, misconception: 0, lastAt: null }, now)
      const touched = !!m && (m.n > 0 || m.K > 0)
      return {
        nodeId: n.id,
        name: n.name,
        parentName: n.parentId ? (nodeById.get(n.parentId)?.name ?? '') : '',
        depth: n.parentId ? (nodeById.get(n.parentId)?.parentId ? 2 : 1) : 0,
        cells,
        mastery: touched ? eff.M : null,
        conf: eff.conf,
        priority: priorityOf.get(n.id) ?? 0,
        totalAttempts: cells.easy.attempts + cells.mid.attempts + cells.hard.attempts
      }
    })

  if (sort === 'priority') {
    rows.sort((a, b) => b.priority - a.priority)
  } else {
    const order = treeOrder(nodes)
    const idx = new Map(order.map((id, i) => [id, i]))
    rows.sort((a, b) => (idx.get(a.nodeId) ?? 0) - (idx.get(b.nodeId) ?? 0))
  }

  return rows
}

export interface HeatSummary {
  total: number
  gaps: number
  unmeasured: number
  /** 全表有多少条疑似蒙对被排除在有效统计外 */
  excluded: number
}

export function summarizeHeat(rows: HeatRow[]): HeatSummary {
  let excluded = 0
  for (const r of rows) for (const b of BANDS) excluded += r.cells[b.key].excluded
  return {
    total: rows.length,
    gaps: rows.filter((r) => r.mastery !== null && r.mastery < 0.4).length,
    unmeasured: rows.filter((r) => r.mastery === null).length,
    excluded
  }
}
