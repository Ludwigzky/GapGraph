import { describe, expect, it } from 'vitest'
import { equivalentAnswer, parseExpr, parseIntervalSet, tidy } from '../src/main/domain/equiv'

/**
 * 填空答案等效判定。
 * 之前只有字符串归一 + 数值比较，下面标 ✅ 的那些全被判错。
 */
describe('区间 ↔ 不等式', () => {
  const cases: [string, string][] = [
    ['x>1', '(1,+∞)'],
    ['x>=1', '[1,+∞)'],
    ['x<2', '(-∞,2)'],
    ['x<=2', '(-∞,2]'],
    ['1<x<2', '(1,2)'],
    ['1<=x<=2', '[1,2]'],
    ['1<x<=2', '(1,2]'],
    ['-1<x<1', '(-1,1)']
  ]
  for (const [a, b] of cases) {
    it(`${a} ≡ ${b}`, () => expect(equivalentAnswer(a, b)).toBe(true))
  }

  it('开闭不能混：x>1 与 x>=1 不等效', () => {
    expect(equivalentAnswer('x>1', 'x>=1')).toBe(false)
  })

  it('端点不能错：(1,2) 与 (1,3) 不等效', () => {
    expect(equivalentAnswer('(1,2)', '(1,3)')).toBe(false)
  })
})

describe('解集写法归一', () => {
  it('x=1或x=2 ≡ 1,2', () => expect(equivalentAnswer('x=1或x=2', '1,2')).toBe(true))
  it('{1,2} ≡ 1,2', () => expect(equivalentAnswer('{1,2}', '1,2')).toBe(true))
  it('顺序无关：2,1 ≡ 1,2', () => expect(equivalentAnswer('2,1', '1,2')).toBe(true))
  it('与区间也能对上：{1,2} ≡ [1,1]∪[2,2]', () => expect(equivalentAnswer('{1,2}', '[1,1]∪[2,2]')).toBe(true))
  it('解集少一个不行：1,2 与 1 不等效', () => expect(equivalentAnswer('1,2', '1')).toBe(false))
})

describe('解析式数值等价', () => {
  it('2(x+1) ≡ 2x+2', () => expect(equivalentAnswer('2(x+1)', '2x+2')).toBe(true))
  it('(x+1)^2 ≡ x^2+2x+1', () => expect(equivalentAnswer('(x+1)^2', 'x^2+2x+1')).toBe(true))
  it('去 y= 前缀：y=2x+1 ≡ 2x+1', () => expect(equivalentAnswer('y=2x+1', '2x+1')).toBe(true))
  it('可识别不等价：2x+1 与 2x+2', () => expect(equivalentAnswer('2x+1', '2x+2')).toBe(false))
  it('可识别系数错：(x+1)^2 与 x^2+1', () => expect(equivalentAnswer('(x+1)^2', 'x^2+1')).toBe(false))
})

describe('数值与排版', () => {
  it('1/2 ≡ 0.5', () => expect(equivalentAnswer('1/2', '0.5')).toBe(true))
  it('全角空格不影响：２ ≡ 2', () => expect(equivalentAnswer('２', '2')).toBe(true))
  it('上标：x² ≡ x^2', () => expect(equivalentAnswer('x²', 'x^2')).toBe(true))
  it('空答案判错', () => expect(equivalentAnswer('1', '')).toBe(false))
})

describe('解析器本身', () => {
  it('区间解析能认出链式不等式', () => {
    expect(parseIntervalSet('1<x<=2')).toEqual([{ lo: { v: 1, open: true }, hi: { v: 2, open: false } }])
  })
  it('认不出的写法返回 null，不瞎猜', () => {
    expect(parseIntervalSet('随便写点什么')).toBe(null)
  })
  it('表达式能解析带函数的写法', () => {
    expect(parseExpr('sqrt(2)')).not.toBe(null)
    expect(parseExpr('2x+1')).not.toBe(null)
  })
  it('tidy 去掉 y= 与空格', () => {
    expect(tidy(' y = 2x + 1 ')).toBe('2x+1')
  })
})
