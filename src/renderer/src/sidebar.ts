/**
 * 三栏布局的可调状态：左右栏宽度 + 是否收起。
 *
 * 和 DeepSeek 的侧栏一个意思：拖动分界线改宽度，收起后只留知识网。
 * 布局属于"这个人习惯怎么看"，所以是全局设置，不按板块存。
 */
export interface LayoutState {
  left: number
  right: number
  leftClosed: boolean
  rightClosed: boolean
}

export const LAYOUT_DEFAULT: LayoutState = {
  left: 268,
  right: 348,
  leftClosed: false,
  rightClosed: false
}

export const LEFT_MIN = 180
export const LEFT_MAX = 420
export const RIGHT_MIN = 260
export const RIGHT_MAX = 760

const KEY = 'gapgraph.layout.v1'

export function clampWidth(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

export function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...LAYOUT_DEFAULT }
    const v = JSON.parse(raw) as Partial<LayoutState>
    return {
      left: clampWidth(Number(v.left), LEFT_MIN, LEFT_MAX),
      right: clampWidth(Number(v.right), RIGHT_MIN, RIGHT_MAX),
      leftClosed: !!v.leftClosed,
      rightClosed: !!v.rightClosed
    }
  } catch {
    return { ...LAYOUT_DEFAULT }
  }
}

export function saveLayout(s: LayoutState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* 忽略 */
  }
}

/** 两边都收起 = 只看知识网 */
export function toggleFocus(s: LayoutState): LayoutState {
  const bothClosed = s.leftClosed && s.rightClosed
  return { ...s, leftClosed: !bothClosed, rightClosed: !bothClosed }
}
