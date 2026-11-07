/* 验证：一个"自评会"的考点，连续答错之后掌握分显示什么 */
import { applyAttempt, freshMastery, masteryScore, band } from '../src/shared/mastery.ts'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 1)

let m = { ...freshMastery(1), A: 0.6 }
console.log('起始（自评会）           M=%s (%s)', masteryScore(m, T0).toFixed(3), band(m, T0))
for (let i = 1; i <= 5; i++) {
  m = applyAttempt(m, {
    difficulty: 3,
    correct: false,
    weight: 1,
    sure: true,
    guessed: false,
    now: T0 + i * 60_000
  })
  const t = T0 + i * 60_000
  console.log(
    '第 %d 次答错 → A=%s M=%s (%s) 累计正确率 %d/%d',
    i,
    m.A.toFixed(2),
    masteryScore(m, t).toFixed(3),
    band(m, t),
    m.nok,
    m.n
  )
}
void DAY
