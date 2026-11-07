import { describe, expect, it } from 'vitest'
import type { KNode, Mastery } from '../src/shared/types'
import {
  SCHEMA_VERSION,
  band,
  effective,
  evidenceOf,
  freshMastery,
  masteryScore,
  migrateMastery,
  selfLevelOf,
  setSelfLevel
} from '../src/shared/mastery'
import { gapPriority, rankGaps, reasonOf } from '../src/main/domain/priority'
import { blankMastery } from '../src/main/domain/queue'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 1)

const node = (id: string, weight = 0.8, prereq: string[] = []): KNode => ({
  id,
  name: id,
  parentId: 'root',
  kind: 'concept',
  examWeight: weight,
  prereq,
  confusable: []
})
const root: KNode = { id: 'root', name: 'root', parentId: null, kind: 'root', examWeight: 1, prereq: [], confusable: [] }

/** 造一个有 n 次有效作答的状态 */
const tested = (correct: number, wrong: number, at = T0): Mastery => {
  const total = correct + wrong
  return {
    ...freshMastery(1),
    A: total ? correct / total : 0.3,
    n: total,
    nok: correct,
    W: total,
    Aw: correct,
    lastAt: at,
    evidence: 'tested',
    schemaVersion: SCHEMA_VERSION,
    abilityFrom: 'v2'
  }
}

describe('v2：未知不等于薄弱', () => {
  it('完全没信息的节点不进入色带判断，也不会被当成红色', () => {
    const m = freshMastery(0)
    expect(evidenceOf(m)).toBe('none')
    expect(band(m, T0)).toBe('unmeasured')
  })

  it('排序里未知节点的理由是 diagnose，不是 weak', () => {
    const nodes = [root, node('u')]
    const mastery = blankMastery(nodes)
    const ranked = rankGaps(nodes, mastery, { now: T0, rush: false })
    expect(ranked[0].reason).toBe('diagnose')
    expect(ranked[0].known).toBe(false)
  })

  it('未知节点和已测薄弱节点相比，未知不会因为"默认 0.3 分"而长期压住它', () => {
    const nodes = [root, node('unknown', 0.8), node('weak', 0.8)]
    const mastery = blankMastery(nodes)
    mastery.weak = tested(0, 5) // 全错，A≈0
    const ranked = rankGaps(nodes, mastery, { now: T0, rush: false })
    const u = ranked.find((r) => r.node.id === 'unknown')!
    const w = ranked.find((r) => r.node.id === 'weak')!
    // 已测出来的洞（1-0=1）应该排在"还没测"（0.55）前面
    expect(w.priority).toBeGreaterThan(u.priority)
    expect(w.reason).toBe('weak')
  })

  it('reasonOf 的分档与阈值一致', () => {
    expect(reasonOf(false, 0)).toBe('diagnose')
    expect(reasonOf(true, 0.2)).toBe('weak')
    expect(reasonOf(true, 0.5)).toBe('practice')
    expect(reasonOf(true, 0.9)).toBe('solid')
  })
})

describe('v2：自评不改能力', () => {
  it('自评"会"不会把能力改成 0.6', () => {
    const before = freshMastery(0)
    const after = setSelfLevel(before, 'basic', T0)
    expect(after.A).toBe(before.A) // 能力没被动过
    expect(selfLevelOf(after)).toBe('basic')
    expect(after.selfAt).toBe(T0)
  })

  it('自评只影响证据来源与展示，不改变 band 的"已测/未测"判定', () => {
    const m = setSelfLevel(freshMastery(0), 'weak', T0)
    expect(evidenceOf(m)).toBe('self')
    expect(band(m, T0)).toBe('self')
  })

  it('自评后再做题，能力由答题决定，不由自评档位决定', () => {
    const rated = setSelfLevel(freshMastery(0), 'basic', T0) // 自称会
    const withEvidence: Mastery = { ...rated, A: 0.1, n: 4, nok: 0, W: 4, Aw: 0, lastAt: T0, evidence: 'tested' }
    expect(masteryScore(withEvidence, T0)).toBeLessThan(0.15)
    expect(band(withEvidence, T0)).toBe('red')
  })
})

describe('v2：可信度与能力分开', () => {
  it('证据少时能力不被拉向默认值', () => {
    const few = tested(1, 0)
    const e = effective(few, T0)
    expect(e.conf).toBeLessThan(0.5)
    expect(e.eff).toBeCloseTo(e.M, 10)
  })

  it('久不练可信度会掉，但能力分不动', () => {
    const m = tested(4, 0)
    const fresh = effective(m, T0)
    const stale = effective(m, T0 + 120 * DAY)
    expect(stale.conf).toBeLessThan(fresh.conf - 0.2)
    expect(stale.M).toBeCloseTo(fresh.M, 10)
  })

  it('低置信度不等于低掌握：高能力 + 低可信度仍然显示高能力', () => {
    const m: Mastery = { ...tested(1, 0), A: 0.95 }
    const e = effective(m, T0)
    expect(e.conf).toBeLessThan(0.4)
    expect(e.M).toBeGreaterThan(0.9)
  })
})

describe('v1 → v2 迁移', () => {
  it('n=0 时 K 只可能来自自评，能可靠还原成 selfLevel', () => {
    const weak = migrateMastery({ ...freshMastery(0), K: 0.5, n: 0, schemaVersion: undefined })
    expect(weak.selfLevel).toBe('weak')
    const basic = migrateMastery({ ...freshMastery(0), K: 1, n: 0, schemaVersion: undefined })
    expect(basic.selfLevel).toBe('basic')
  })

  it('n>0 时 K 被答题改过，无法分离 → 标 unknown，不编造用户态度', () => {
    const m = migrateMastery({ ...freshMastery(1), K: 0.7, n: 5, nok: 3, schemaVersion: undefined })
    expect(m.selfLevel).toBe('unknown')
    expect(m.abilityFrom).toBe('v1')
  })

  it('旧 A / W / Aw / s / lastAt / n / nok / misconception 一个都不丢', () => {
    const old: Mastery = {
      K: 0.5,
      A: 0.42,
      s: 3.5,
      n: 7,
      nok: 4,
      W: 6.1,
      Aw: 2.7,
      misconception: 1,
      lastAt: T0,
      evidence: 'tested'
    }
    const m = migrateMastery(old)
    expect(m.A).toBe(0.42)
    expect(m.s).toBe(3.5)
    expect(m.n).toBe(7)
    expect(m.nok).toBe(4)
    expect(m.W).toBe(6.1)
    expect(m.Aw).toBe(2.7)
    expect(m.misconception).toBe(1)
    expect(m.lastAt).toBe(T0)
  })

  it('幂等：重复迁移不改任何数', () => {
    const once = migrateMastery({ ...freshMastery(1), K: 0.7, n: 5, nok: 3, schemaVersion: undefined })
    const twice = migrateMastery(once)
    expect(twice).toEqual(once)
    expect(twice.schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('迁移不改变能力分（只有 K/R 从公式里拿掉带来的变化）', () => {
    const old: Mastery = { ...freshMastery(1), K: 1, A: 0.8, n: 5, nok: 4, W: 5, Aw: 4, lastAt: T0, schemaVersion: undefined }
    const m = migrateMastery(old)
    expect(masteryScore(m, T0)).toBeCloseTo(0.8, 10)
  })
})

describe('v2：自评不会把没学的节点顶成高分', () => {
  it('自评"会"但没做题，分数只到自评参考值，不进绿区', () => {
    const m = setSelfLevel(freshMastery(0), 'basic', T0)
    expect(masteryScore(m, T0)).toBeLessThan(0.4)
    expect(band(m, T0)).toBe('self')
  })

  it('未知节点在优先级里用的是诊断基数，与考试重要性成正比', () => {
    const hi = gapPriority(node('a', 0.9), freshMastery(0), [], { now: T0, rush: false })
    const lo = gapPriority(node('b', 0.3), freshMastery(0), [], { now: T0, rush: false })
    expect(hi).toBeGreaterThan(lo)
  })
})
