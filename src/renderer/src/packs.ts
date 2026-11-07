import type { Pack } from '../../shared/types'
import builtin from '../../../resources/packs/gaokao-math-function.json'

const CUSTOM_KEY = 'gapgraph.packs.v1'
const ACTIVE_KEY = 'gapgraph.activepack.v1'

export interface PackEntry {
  id: string
  title: string
  builtin: boolean
}

const BUILTIN = builtin as unknown as Pack

export function builtinPack(): Pack {
  return BUILTIN
}

export function customPacks(): Record<string, Pack> {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY)
    return raw ? (JSON.parse(raw) as Record<string, Pack>) : {}
  } catch {
    return {}
  }
}

export function listPacks(): PackEntry[] {
  const out: PackEntry[] = [{ id: BUILTIN.packId, title: BUILTIN.title, builtin: true }]
  for (const p of Object.values(customPacks())) {
    out.push({ id: p.packId, title: p.title, builtin: false })
  }
  return out
}

export function activePackId(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setActivePackId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, id)
  } catch {
    /* 忽略 */
  }
}

export function resolvePack(id: string): Pack | null {
  if (id === BUILTIN.packId) return BUILTIN
  return customPacks()[id] ?? null
}

/** 当前该用哪一份考纲；没有任何选择时返回 null，交给引导流程 */
export function currentPack(): Pack | null {
  const id = activePackId()
  if (!id) return null
  return resolvePack(id)
}

export function saveCustomPack(pack: Pack): void {
  const all = customPacks()
  all[pack.packId] = pack
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(all))
  } catch {
    /* 忽略 */
  }
}

export function removeCustomPack(id: string): void {
  const all = customPacks()
  delete all[id]
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(all))
  } catch {
    /* 忽略 */
  }
  if (activePackId() === id) setActivePackId(BUILTIN.packId)
}

export function stateKeyFor(packId: string): string {
  return `gapgraph.state.${packId}.v1`
}

/** 大厅用：这个板块学到哪儿了 */
export interface PackProgress {
  measured: number
  total: number
  lastAt: number
  hasQuestions: boolean
}

const STUDIED_KEY = (id: string): string => `gapgraph.studied.${id}`

export function markStudied(packId: string): void {
  try {
    localStorage.setItem(STUDIED_KEY(packId), String(Date.now()))
  } catch {
    /* 忽略 */
  }
}

export function packProgress(packId: string): PackProgress {
  const pack = resolvePack(packId)
  const total = pack ? pack.nodes.filter((n) => n.kind !== 'root').length : 0
  let measured = 0
  let lastAt = 0
  try {
    const raw = localStorage.getItem(stateKeyFor(packId))
    if (raw) {
      const s = JSON.parse(raw) as { mastery?: Record<string, { n?: number }>; attempts?: { submittedAt?: number }[] }
      const m = s.mastery ?? {}
      measured = Object.values(m).filter((x) => (x?.n ?? 0) > 0).length
      const last = s.attempts?.[s.attempts.length - 1]
      lastAt = last?.submittedAt ?? 0
    }
    const stored = localStorage.getItem(STUDIED_KEY(packId))
    if (stored) lastAt = Math.max(lastAt, Number(stored) || 0)
  } catch {
    /* 忽略 */
  }
  return { measured, total, lastAt, hasQuestions: packId === BUILTIN.packId }
}

export function relTime(ts: number): string {
  if (!ts) return '还没开始'
  const d = Date.now() - ts
  const min = Math.floor(d / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const day = Math.floor(h / 24)
  if (day === 1) return '昨天'
  if (day < 30) return `${day} 天前`
  return `${Math.floor(day / 30)} 个月前`
}
