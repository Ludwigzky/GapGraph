/**
 * 填空/简答答案的"语义等效"判定。
 *
 * 原来只做字符串归一 + 数值比较，于是这些全被判错：
 *   x>1       vs  (1,+∞)
 *   (1,2)     vs  1<x<2
 *   y=2x+1    vs  2x+1
 *   x=1或x=2  vs  1,2
 *   2(x+1)    vs  2x+2
 *
 * 这里用两层确定性手段：
 *   ① 规范化：区间 ↔ 不等式、解集三种写法归一、去 y= 前缀、集合排序
 *   ② 数值代入：含变量的解析式，抽几个点代入两边，值相等即等效
 *
 * 都不确定时返回 false —— 宁可判错让人重看，也不要放过真错的答案。
 */

/* ---------------- 基础归一 ---------------- */

const SUP: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' }

/** 只做"排版级"归一：字符、空格、前缀，不改变语义 */
export function tidy(raw: string): string {
  let s = String(raw ?? '')
    .trim()
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)) // 全角转半角
    .replace(/[−–—]/g, '-')
    .replace(/[×✕✖·]/g, '*')
    .replace(/[÷]/g, '/')
    .replace(/[≤]/g, '<=')
    .replace(/[≥]/g, '>=')
    .replace(/[≠]/g, '!=')
    .replace(/[，、；]/g, ',')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[｛{]/g, '{')
    .replace(/[｝}]/g, '}')
    .replace(/[。．]$/g, '')
    .replace(/[∞]/g, 'inf')
    .replace(/＋/g, '+')

  // 上标数字转 ^n：x² → x^2
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (m) => '^' + [...m].map((c) => SUP[c] ?? c).join(''))

  // 去掉"答案：""x="这类前缀（x= 在解集里另算）
  s = s.replace(/^(答案|答)\s*[:：]?\s*/, '')
  s = s.replace(/^(y|f\s*\(\s*x\s*\)|s|v|a)\s*=\s*/i, '')

  return s.replace(/\s+/g, '').toLowerCase()
}

const num = (s: string): number | null => {
  const t = s.trim()
  if (t === 'inf' || t === '+inf') return Infinity
  if (t === '-inf') return -Infinity
  const frac = t.match(/^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/)
  if (frac) {
    const a = Number(frac[1])
    const b = Number(frac[2])
    return b === 0 ? null : a / b
  }
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t)
  return null
}

/* ---------------- ① 区间 / 解集 ---------------- */

export interface Bound {
  v: number
  open: boolean
}
export interface Interval {
  lo: Bound
  hi: Bound
}

const cmpBound = (x: Bound, y: Bound): number => x.v - y.v || Number(x.open) - Number(y.open)

/** 把若干区间排序、合并重叠，得到唯一表示 */
export function canonicalIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => cmpBound(a.lo, b.lo) || cmpBound(a.hi, b.hi))
  const out: Interval[] = []
  for (const iv of sorted) {
    const last = out[out.length - 1]
    if (!last) {
      out.push({ ...iv })
      continue
    }
    const touches = iv.lo.v < last.hi.v || (iv.lo.v === last.hi.v && !iv.lo.open && !last.hi.open)
    if (touches) {
      if (cmpBound(iv.hi, last.hi) > 0) last.hi = { ...iv.hi }
    } else {
      out.push({ ...iv })
    }
  }
  return out
}

const ivKey = (ivs: Interval[]): string =>
  canonicalIntervals(ivs)
    .map((i) => `${i.lo.open ? '(' : '['}${i.lo.v},${i.hi.v}${i.hi.open ? ')' : ']'}`)
    .join('∪')

/** 单个区间写法：(1,2) [1,2] (1,inf) [-inf,0) */
function parseIntervalToken(tok: string): Interval | null {
  const m = tok.match(/^([([{])([^,]+),([^)\]}]+)([)\]])$/)
  if (!m) return null
  const lo = num(m[2])
  const hi = num(m[3])
  if (lo === null || hi === null) return null
  return { lo: { v: lo, open: m[1] !== '[' }, hi: { v: hi, open: m[4] !== ']' } }
}

/** 单个不等式：x>1 / x>=1 / x<2 / x<=2 */
function parseUnequal(tok: string): Interval | null {
  const m = tok.match(/^[a-z]?(<=|>=|<|>)(-?\d+(?:\.\d+)?|-?inf)$/)
  if (!m) return null
  const v = num(m[2])
  if (v === null) return null
  const open = m[1] === '<' || m[1] === '>'
  if (m[1] === '>' || m[1] === '>=') return { lo: { v, open }, hi: { v: Infinity, open: true } }
  return { lo: { v: -Infinity, open: true }, hi: { v, open } }
}

/** 链式不等式：1<x<2、1<=x<=2、1<x<=2、x>1 也走这里 */
function parseChain(tok: string): Interval | null {
  const m = tok.match(/^(-?\d+(?:\.\d+)?|-?inf)\s*(<=|>=|<|>)\s*[a-z]\s*(<=|>=|<|>)\s*(-?\d+(?:\.\d+)?|-?inf)$/)
  if (!m) return null
  const a = num(m[1])
  const b = num(m[4])
  if (a === null || b === null) return null
  // 1<x  → x>1；x<2 → x<2
  const left = m[2]
  const right = m[3]
  if (!/^</.test(left) || !/^</.test(right)) return null
  return { lo: { v: a, open: left === '<' }, hi: { v: b, open: right === '<' } }
}

/**
 * 把一段答案解析成"区间集合"。认不出返回 null。
 * 支持：(1,+∞)、1<x<2、(1,2)∪(3,4)、x>1或x<-1
 */
export function parseIntervalSet(raw: string): Interval[] | null {
  const s = tidy(raw).replace(/∪/g, '|').replace(/或|or|且|and/g, '|')
  const parts = s.split('|').filter(Boolean)
  if (!parts.length) return null

  // 纯数字列表（解集）：1,2 / {1,2} / x=1,x=2 / x=1或x=2
  const bare = s.replace(/[{}]/g, '')
  const nums = bare
    .split(/[,|]/)
    .map((x) => x.replace(/^[a-z]=/, '').trim())
    .filter((x) => x !== '')
  if (nums.length > 0 && nums.every((n) => num(n) !== null)) {
    return nums.map((n) => {
      const v = num(n) as number
      return { lo: { v, open: false }, hi: { v, open: false } }
    })
  }

  const out: Interval[] = []
  for (const p of parts) {
    // 单独一个 x=3 也当成点值
    const asPoint = p.match(/^[a-z]?=?(-?\d+(?:\.\d+)?)$/)
    if (asPoint) {
      const v = num(asPoint[1]) as number
      out.push({ lo: { v, open: false }, hi: { v, open: false } })
      continue
    }
    const iv = parseIntervalToken(p) ?? parseChain(p) ?? parseUnequal(p)
    if (!iv) return null
    out.push(iv)
  }
  return out
}

/* ---------------- ② 解析式：数值代入 ---------------- */

type Node =
  | { k: 'num'; v: number }
  | { k: 'var'; name: string }
  | { k: 'neg'; a: Node }
  | { k: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Node; b: Node }
  | { k: 'fn'; name: string; a: Node }

const FUNCS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  ln: Math.log,
  log: Math.log10,
  exp: Math.exp
}

/** 极小的表达式解析器：数字、单字母变量、+ - * / ^、括号、几个常用函数、π/e */
export function parseExpr(input: string): Node | null {
  const s = tidy(input).replace(/\*\*/g, '^').replace(/π/g, 'pi')
  let i = 0
  const peek = (): string => s[i] ?? ''
  const eat = (ch: string): boolean => {
    if (peek() === ch) {
      i++
      return true
    }
    return false
  }

  function parseAtom(): Node | null {
    if (eat('(')) {
      const inner = parseSum()
      if (!inner || !eat(')')) return null
      return inner
    }
    if (eat('-')) {
      const a = parseAtom()
      return a ? { k: 'neg', a } : null
    }
    if (eat('+')) return parseAtom()

    const rest = s.slice(i)
    const fn = rest.match(/^(sqrt|abs|sin|cos|tan|ln|log|exp)\(/)
    if (fn) {
      i += fn[0].length // 连左括号一起跳过，右括号留到最后 eat
      const a = parseSum()
      if (!a || !eat(')')) return null
      return { k: 'fn', name: fn[1], a }
    }
    const NUM = rest.match(/^(\d+(?:\.\d+)?|\.\d+)/)
    if (NUM) {
      i += NUM[0].length
      // 支持 2x 这种隐式乘法
      const after = s.slice(i)
      const VAR = after.match(/^[a-z]/)
      if (VAR) {
        i += 1
        return { k: 'bin', op: '*', a: { k: 'num', v: Number(NUM[0]) }, b: { k: 'var', name: VAR[0] } }
      }
      return { k: 'num', v: Number(NUM[0]) }
    }
    const IDENT = rest.match(/^[a-z]+/)
    if (IDENT) {
      const name = IDENT[0]
      if (name === 'pi') {
        i += 2
        return { k: 'num', v: Math.PI }
      }
      if (name === 'e') {
        i += 1
        return { k: 'num', v: Math.E }
      }
      if (name.length === 1) {
        i += 1
        return { k: 'var', name }
      }
      return null
    }
    return null
  }

  function parsePow(): Node | null {
    const base = parseAtom()
    if (!base) return null
    if (eat('^')) {
      const exp = parsePow()
      return exp ? { k: 'bin', op: '^', a: base, b: exp } : null
    }
    return base
  }

  function parseProd(): Node | null {
    let left = parsePow()
    if (!left) return null
    for (;;) {
      if (eat('*')) {
        const r = parsePow()
        if (!r) return null
        left = { k: 'bin', op: '*', a: left, b: r }
      } else if (eat('/')) {
        const r = parsePow()
        if (!r) return null
        left = { k: 'bin', op: '/', a: left, b: r }
      } else if (/^[a-z(]/.test(peek()) && /[a-z0-9)]$/.test(s[i - 1] ?? '')) {
        // 隐式乘法：2x、(x+1)(x-1)、2(x+1)
        const r = parsePow()
        if (!r) return null
        left = { k: 'bin', op: '*', a: left, b: r }
      } else return left
    }
  }

  function parseSum(): Node | null {
    let left = parseProd()
    if (!left) return null
    for (;;) {
      if (eat('+')) {
        const r = parseProd()
        if (!r) return null
        left = { k: 'bin', op: '+', a: left, b: r }
      } else if (eat('-')) {
        const r = parseProd()
        if (!r) return null
        left = { k: 'bin', op: '-', a: left, b: r }
      } else return left
    }
  }

  const ast = parseSum()
  if (!ast || i !== s.length) return null
  return ast
}

export function evalExpr(n: Node, env: Record<string, number>): number {
  switch (n.k) {
    case 'num':
      return n.v
    case 'var':
      return env[n.name] ?? NaN
    case 'neg':
      return -evalExpr(n.a, env)
    case 'fn':
      return FUNCS[n.name](evalExpr(n.a, env))
    case 'bin': {
      const a = evalExpr(n.a, env)
      const b = evalExpr(n.b, env)
      switch (n.op) {
        case '+':
          return a + b
        case '-':
          return a - b
        case '*':
          return a * b
        case '/':
          return a / b
        case '^':
          return Math.pow(a, b)
      }
    }
  }
}

function varsOf(n: Node, acc: Set<string> = new Set()): Set<string> {
  if (n.k === 'var') acc.add(n.name)
  else if (n.k === 'neg') varsOf(n.a, acc)
  else if (n.k === 'fn') varsOf(n.a, acc)
  else if (n.k === 'bin') {
    varsOf(n.a, acc)
    varsOf(n.b, acc)
  }
  return acc
}

/** 固定的取样点：确定性，测试可复现 */
const SAMPLES = [0.37, 1.23, -0.81, 2.57, -1.93, 0.5, 3.1]

function close(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b))
}

/** 两个解析式是否在数值上等价（抽样代入） */
export function sameExpr(a: Node, b: Node): boolean {
  const vars = new Set([...varsOf(a), ...varsOf(b)])
  const names = [...vars]
  let checked = 0
  for (const s of SAMPLES) {
    const env: Record<string, number> = {}
    for (const [k, name] of names.entries()) env[name] = s + k * 0.13
    let va: number
    let vb: number
    try {
      va = evalExpr(a, env)
      vb = evalExpr(b, env)
    } catch {
      continue
    }
    if (!Number.isFinite(va) || !Number.isFinite(vb)) continue
    if (!close(va, vb)) return false
    checked++
  }
  return checked >= 3
}

/* ---------------- 对外入口 ---------------- */

/**
 * 判定"学生答案"与"题库答案"是否等效。
 * 依次尝试：排版归一 → 数值 → 区间/解集 → 解析式抽样。
 */
export function equivalentAnswer(expected: string, given: string): boolean {
  const a = tidy(expected)
  const b = tidy(given)
  if (!a || !b) return false
  if (a === b) return true

  // 纯数值（1/2 = 0.5）
  const na = num(a)
  const nb = num(b)
  if (na !== null && nb !== null) return close(na, nb)

  // 区间 / 不等式 / 解集
  const ia = parseIntervalSet(a)
  const ib = parseIntervalSet(b)
  if (ia && ib && ivKey(ia) === ivKey(ib)) return true

  // 解析式（含变量）
  const pa = parseExpr(a)
  const pb = parseExpr(b)
  if (pa && pb) {
    if (varsOf(pa).size === 0 && varsOf(pb).size === 0) {
      const va = evalExpr(pa, {})
      const vb = evalExpr(pb, {})
      if (Number.isFinite(va) && Number.isFinite(vb)) return close(va, vb)
    }
    return sameExpr(pa, pb)
  }

  return false
}
