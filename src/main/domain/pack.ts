import type { KNode, Pack } from '../../shared/types'

/** AI 生成的考纲可能不守规矩，这里做一次严格规整：保证图能画、能算、不会崩 */
export function normalizeGeneratedPack(raw: {
  exam: string
  subject: string
  chapter: string
  nodes: unknown[]
}): Pack {
  const input = Array.isArray(raw.nodes) ? raw.nodes : []
  const seen = new Set<string>()
  const nodes: KNode[] = []

  input.forEach((item, i) => {
    const n = item as Record<string, unknown>
    let id = String(n.id ?? `n${i + 1}`).slice(0, 40)
    if (!id || seen.has(id)) id = `n${i + 1}`
    seen.add(id)
    const kind = n.kind === 'root' || n.kind === 'skill' ? n.kind : 'concept'
    const w = Number(n.examWeight)
    nodes.push({
      id,
      name: String(n.name ?? `考点${i + 1}`).slice(0, 24),
      parentId: n.parentId == null ? null : String(n.parentId).slice(0, 40),
      kind,
      // 注意 0 是合法输入，不能写成 Number(x) || 0.5（0 会被吞掉）
      examWeight: Math.min(1, Math.max(0.2, Number.isFinite(w) ? w : 0.5)),
      // 模型给的是"重要性估计"，没有任何真题统计支撑，标成 ai
      weightSource: 'ai',
      prereq: Array.isArray(n.prereq) ? n.prereq.map((p) => String(p).slice(0, 40)) : [],
      confusable: [],
      brief: String(n.brief ?? '').slice(0, 120)
    })
  })

  // 选根：优先 kind=root，其次 parentId 为空的，最后第一个；选中的强制立为根
  const root =
    nodes.find((n) => n.kind === 'root') ??
    nodes.find((n) => n.parentId === null) ??
    nodes[0]
  if (root) {
    root.kind = 'root'
    root.parentId = null
  }
  const rootId = root?.id ?? null
  for (const n of nodes) {
    if (n !== root && n.kind === 'root') n.kind = 'concept'
  }

  // 悬空的 parentId 挂到根上；自引用的也挂上去
  const ids = new Set(nodes.map((n) => n.id))
  for (const n of nodes) {
    if (n.id === rootId) {
      n.parentId = null
      continue
    }
    if (!n.parentId || n.parentId === n.id || !ids.has(n.parentId)) n.parentId = rootId ?? null
  }

  // 成环检测：沿 parent 往上走，超过节点数就一定成环，挂回根
  for (const n of nodes) {
    let cur = n
    let hops = 0
    while (cur.parentId && hops <= nodes.length) {
      const p = nodes.find((x) => x.id === cur.parentId)
      if (!p) break
      cur = p
      hops++
    }
    if (hops > nodes.length) n.parentId = rootId ?? null
  }

  // prereq 只保留存在的、且不是自己的
  for (const n of nodes) {
    n.prereq = n.prereq.filter((p) => p !== n.id && ids.has(p))
  }

  const packId = `ai-${Date.now().toString(36)}`
  return {
    packId,
    title: `${raw.exam} · ${raw.subject} · ${raw.chapter}`.slice(0, 60),
    subject: raw.subject.slice(0, 20),
    totalScore: 150,
    source: `AI 生成（${raw.chapter}）`,
    meta: { exam: raw.exam, subject: raw.subject, chapter: raw.chapter },
    nodes,
    relations: []
  }
}

/** 兜底：把任意来源的 pack 校验成可用的形状 */
export function isUsablePack(p: Pack | null | undefined): p is Pack {
  return !!p && Array.isArray(p.nodes) && p.nodes.length >= 5 && !!p.nodes.find((n) => n.kind === 'root')
}
