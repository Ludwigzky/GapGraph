import { describe, expect, it } from 'vitest'
import { conclusionPolarity, countMismatch, judgeAnswerIsTrue, qcProblems, verifyPromptFor } from '../scripts/question-qc.cjs'

/**
 * 这组用例的核心是一条真实事故：
 * 化学判断题「C4H10 两种异构体的一氯代物分别是 2 种和 2 种」
 * 答案键被写成 false，而解析最后结论是「说法正确」。
 * 出题与复核同模型，两次都错，双双放行。
 */
const BAD = {
  type: 'judge',
  stem: '分子式为C4H10的烷烃只有两种同分异构体，它们的一氯代物数目分别为2种和2种。',
  answer: 'false',
  solution:
    'C4H10有正丁烷和异丁烷两种。正丁烷的一氯代物有2种（1-氯丁烷、2-氯丁烷），' +
    '异丁烷的一氯代物也有2种（1-氯-2-甲基丙烷、2-氯-2-甲基丙烷），故说法正确？' +
    '异丁烷中两种一氯代物，共2种，所以说法正确。修正答案为正解。'
}

describe('解析自洽闸门', () => {
  it('抓得住那道真实的错题：答案是 false，解析却结论为正确', () => {
    const problems = qcProblems(BAD)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems[0]).toContain('解析结论与答案矛盾')
  })

  it('把 answer 改成 true 就通过（说明是答案键的问题，不是题目的问题）', () => {
    expect(qcProblems({ ...BAD, answer: 'true' })).toEqual([])
  })

  it('正常判断题不会被误杀', () => {
    expect(qcProblems({ type: 'judge', stem: 'x', answer: 'true', solution: '两项相等，所以命题正确。' })).toEqual([])
    expect(qcProblems({ type: 'judge', stem: 'x', answer: 'false', solution: '存在反例，故命题错误。' })).toEqual([])
  })

  it('否定词要能区分："不正确"不能算成正确', () => {
    expect(conclusionPolarity('所以该说法不正确。')).toBe('false')
    expect(conclusionPolarity('所以该说法正确。')).toBe('true')
    expect(conclusionPolarity('证毕，无额外结论。')).toBe(null)
  })

  it('只对判断题生效，填空和单选不受影响', () => {
    expect(qcProblems({ type: 'blank', stem: 'x', answer: '3/2', solution: '所以答案是 3/2。' })).toEqual([])
    expect(
      qcProblems({ type: 'single', stem: 'x', options: ['a', 'b', 'c', 'd'], answer: 'a', solution: 'B 不对，C 不对，所以选 A，正确。' })
    ).toEqual([])
  })

  it('计数写错也要抓：说有 3 种却只列了 2 项', () => {
    expect(countMismatch('正丁烷有3种（1-氯丁烷、2-氯丁烷）')).toContain('只列出了 2 项')
    expect(countMismatch('正丁烷有2种（1-氯丁烷、2-氯丁烷）')).toBe(null)
  })

  it('答案写法归一：中文/英文都能读', () => {
    expect(judgeAnswerIsTrue('正确')).toBe(true)
    expect(judgeAnswerIsTrue('false')).toBe(false)
    expect(judgeAnswerIsTrue('可能')).toBe(null)
  })
})

describe('复核提示词：强制先列中间结果', () => {
  it('判断题要求逐项列出，再判真假', () => {
    const p = verifyPromptFor(BAD)
    expect(p).toContain('逐一列出')
    expect(p).toContain('判断命题真假')
    expect(p).not.toContain('答案：false') // 绝不能把生成方的答案透给复核
  })

  it('单选题要求逐个选项说明对错', () => {
    const p = verifyPromptFor({ type: 'single', stem: 's', options: ['a', 'b', 'c', 'd'], answer: 'a' })
    expect(p).toContain('逐个')
    expect(p).toContain('A. a')
  })

  it('填空题要求先写中间步骤', () => {
    const p = verifyPromptFor({ type: 'blank', stem: 's', answer: '3' })
    expect(p).toContain('中间步骤')
  })
})
