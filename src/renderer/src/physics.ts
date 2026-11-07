/**
 * 图谱力学参数：持久化 + 元数据（滑杆的标签、范围、说明）。
 *
 * 放在全局而不是按板块存：手感是"你这个人习惯怎么读图"，
 * 不该每换一章就变一次。
 */
export interface PhysicsParams {
  /** 节点互斥，越负越散 */
  charge: number
  /** 连线静止长度 */
  linkDistance: number
  /** 连线弹簧强度 */
  linkStrength: number
  /** 整体重心对齐（不按节点施力） */
  recenter: number
  /** 速度衰减，越大越黏 */
  velocityDecay: number
  /** 单帧位移上限 */
  maxStep: number
  /** 斥力最小距离钳制 */
  minDistance: number
}

export const PHYSICS_DEFAULTS: PhysicsParams = {
  charge: -150,
  linkDistance: 140,
  linkStrength: 0.54,
  recenter: 0.08,
  velocityDecay: 0.45,
  maxStep: 6,
  minDistance: 55
}

export interface SliderMeta {
  key: keyof PhysicsParams
  label: string
  hint: string
  min: number
  max: number
  step: number
  /** 展示用的换算（比如斥力存负数，显示正数更直观） */
  display?: (v: number) => number
  parse?: (v: number) => number
}

export const PHYSICS_SLIDERS: SliderMeta[] = [
  {
    key: 'charge',
    label: '节点斥力',
    hint: '越大越松散；太小会挤成一团',
    min: 40,
    max: 400,
    step: 10,
    display: (v) => -v,
    parse: (v) => -v
  },
  {
    key: 'linkDistance',
    label: '连线长度',
    hint: '相连的两个考点想保持多远',
    min: 70,
    max: 260,
    step: 5
  },
  {
    key: 'linkStrength',
    label: '连线强度',
    hint: '越大越"捆得紧"，同层的会抱成一簇',
    min: 0.1,
    max: 1,
    step: 0.02
  },
  {
    key: 'recenter',
    label: '向心（重心对齐）',
    hint: '只把整体拉回画布中心，不改变形状',
    min: 0,
    max: 0.3,
    step: 0.01
  },
  {
    key: 'velocityDecay',
    label: '阻尼',
    hint: '越大越黏、越不容易晃',
    min: 0.2,
    max: 0.8,
    step: 0.02
  },
  {
    key: 'maxStep',
    label: '单帧限速',
    hint: '每帧最多挪几像素，越小越稳越慢',
    min: 2,
    max: 14,
    step: 1
  },
  {
    key: 'minDistance',
    label: '近距钳制',
    hint: '两个点挨太近时不再加大斥力，防止发抖',
    min: 20,
    max: 120,
    step: 5
  }
]

const KEY = 'gapgraph.physics.v1'

export function loadPhysics(): PhysicsParams {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...PHYSICS_DEFAULTS }
    const v = JSON.parse(raw) as Partial<PhysicsParams>
    const out = { ...PHYSICS_DEFAULTS }
    for (const k of Object.keys(PHYSICS_DEFAULTS) as (keyof PhysicsParams)[]) {
      const n = Number(v[k])
      if (Number.isFinite(n)) out[k] = k === 'charge' ? Math.min(-1, n) : Math.max(0, n)
    }
    return out
  } catch {
    return { ...PHYSICS_DEFAULTS }
  }
}

export function savePhysics(p: PhysicsParams): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* 忽略 */
  }
}

export function resetPhysics(): PhysicsParams {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* 忽略 */
  }
  return { ...PHYSICS_DEFAULTS }
}
