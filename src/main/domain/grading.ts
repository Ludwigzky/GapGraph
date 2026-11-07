import type { Question } from '../../shared/types'
import { equivalentAnswer } from './equiv'

/** 统一归一化：全角转半角、去空格、统一不等号/根号/括号/乘除写法 */
export function normalize(raw: string): string {
  return raw
    .trim()
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[≥]/g, '>=')
    .replace(/[≤]/g, '<=')
    .replace(/[≠]/g, '!=')
    .replace(/[−–—]/g, '-')
    .replace(/根号/g, '√')
    .replace(/[√]/g, '√')
    // ^{2x} / {2x} 里的花括号和圆括号等价，统一成圆括号
    .replace(/[{}]/g, (c) => (c === '{' ? '(' : ')'))
    .replace(/[×✕✖]/g, '*')
    .replace(/[÷]/g, '/')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[，]/g, ',')
    .replace(/[。．.]$/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** 把 "3/2"、"1.5"、"-1" 这类答案读成数值，读不出则返回 null */
export function numeric(raw: string): number | null {
  const s = normalize(raw)
  const frac = s.match(/^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/)
  if (frac) {
    const a = Number(frac[1])
    const b = Number(frac[2])
    return b === 0 ? null : a / b
  }
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s)
  return null
}

export function isCorrect(question: Question, userAnswer: string): boolean {
  const given = normalize(userAnswer)
  if (given === '') return false

  const accepted = Array.isArray(question.answer) ? question.answer : [question.answer]
  for (const raw of accepted) {
    const target = normalize(raw)
    if (given === target) return true
    const a = numeric(given)
    const b = numeric(target)
    if (a !== null && b !== null && Math.abs(a - b) < 1e-9) return true
    // 语义等效：x>1 ≡ (1,+∞)、2(x+1) ≡ 2x+2、x=1或x=2 ≡ 1,2
    if (equivalentAnswer(String(raw), String(userAnswer))) return true
  }
  return false
}

export const JUDGE_LABEL: Record<string, string> = { true: '正确', false: '错误' }
