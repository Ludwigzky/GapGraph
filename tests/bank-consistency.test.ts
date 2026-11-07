import { describe, expect, it } from 'vitest'
import { isCorrect } from '../src/main/domain/grading'
import type { Question } from '../src/shared/types'
import bankJson from '../resources/questions/gaokao-math-function.json'

/**
 * 安全网：等效判定放宽了"算对"的口径，必须保证不放宽到把错答案也判对，
 * 也不能把内置题库的标准答案判错。
 */
const bank: Question[] = (Array.isArray(bankJson) ? bankJson : (bankJson as { questions: Question[] }).questions) as Question[]

describe('内置题库自洽', () => {
  it('每道题都必须接受自己的标准答案', () => {
    const bad = bank.filter((q) => !isCorrect(q, String(Array.isArray(q.answer) ? q.answer[0] : q.answer)))
    expect(bad.map((q) => `${q.id}:${q.type}`)).toEqual([])
  })

  it('判断题的相反答案必须判错', () => {
    const judges = bank.filter((q) => q.type === 'judge')
    const wrong = judges.filter((q) => isCorrect(q, String(q.answer) === 'true' ? 'false' : 'true'))
    expect(wrong.map((q) => q.id)).toEqual([])
  })

  it('单选题选错选项必须判错', () => {
    const singles = bank.filter((q) => q.type === 'single')
    const wrong = singles.filter((q) => {
      const opts = q.options ?? []
      const other = opts.find((o) => o !== q.answer)
      return other ? isCorrect(q, other) : false
    })
    expect(wrong.map((q) => q.id)).toEqual([])
  })

  it('乱填的答案不能蒙对（抽样 40 题）', () => {
    const junk = ['asdf', '不知道', '42', '-999', 'x+y+z']
    const sample = bank.slice(0, 40)
    const passed = sample.filter((q) => junk.some((j) => isCorrect(q, j)))
    // 允许极少数巧合（比如某题标准答案就是 42），但不能成片通过
    expect(passed.length).toBeLessThanOrEqual(2)
  })
})
