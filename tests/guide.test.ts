import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { GUIDE_RELEASES, GUIDE_RULES, GUIDE_STEPS, GUIDE_VERSION } from '../src/renderer/src/guide'

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

describe('使用指南', () => {
  it('版本号与 package.json 一致（升版本就必须来改这里）', () => {
    expect(GUIDE_VERSION).toBe(pkg.version)
  })

  it('最新一条更新记录就是当前版本，且至少写了一条改动', () => {
    const latest = GUIDE_RELEASES[0]
    expect(latest).toBeDefined()
    expect(latest.version).toBe(GUIDE_VERSION)
    expect(latest.items.length).toBeGreaterThan(0)
    for (const item of latest.items) expect(item.trim().length).toBeGreaterThan(8)
  })

  it('指南步骤与规矩都写全了，不留空占位', () => {
    expect(GUIDE_STEPS.length).toBeGreaterThanOrEqual(5)
    for (const s of GUIDE_STEPS) {
      expect(s.title.trim().length).toBeGreaterThan(0)
      expect(s.body.trim().length).toBeGreaterThan(10)
    }
    expect(GUIDE_RULES.length).toBeGreaterThanOrEqual(3)
  })

  it('更新记录按版本倒序排列', () => {
    for (let i = 1; i < GUIDE_RELEASES.length; i++) {
      expect(GUIDE_RELEASES[i - 1].version >= GUIDE_RELEASES[i].version).toBe(true)
    }
  })
})
