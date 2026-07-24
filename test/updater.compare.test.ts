import { describe, it, expect } from 'vitest'
import { compareVersions, shouldCheck, CHECK_INTERVAL_MS } from '../src/updater.js'

describe('compareVersions', () => {
  it('比较主次修订号', () => {
    expect(compareVersions('0.9.3', '0.9.2')).toBe(1)
    expect(compareVersions('0.9.2', '0.9.3')).toBe(-1)
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
    expect(compareVersions('0.9.2', '0.9.2')).toBe(0)
  })

  it('忽略 +build 元数据后缀', () => {
    expect(compareVersions('0.9.2+abc123', '0.9.2')).toBe(0)
    expect(compareVersions('0.9.3+sha', '0.9.2')).toBe(1)
  })

  it('任一侧含预发布标记一律判 0（保守不升级）', () => {
    expect(compareVersions('0.9.3-beta.1', '0.9.2')).toBe(0)
    expect(compareVersions('0.9.3', '0.9.2-rc1')).toBe(0)
  })

  it('非法版本串判 0，不抛异常', () => {
    expect(compareVersions('', '0.9.2')).toBe(0)
    expect(compareVersions('latest', '0.9.2')).toBe(0)
    expect(compareVersions('0.9', '0.9.2')).toBe(0)
    expect(compareVersions('a.b.c', '0.9.2')).toBe(0)
  })
})

describe('shouldCheck', () => {
  const now = 1_000_000_000_000

  it('state 缺失判 true', () => {
    expect(shouldCheck(null, now)).toBe(true)
  })

  it('未过期判 false', () => {
    expect(shouldCheck({ lastCheckAt: now - 1000 }, now)).toBe(false)
  })

  it('超过间隔判 true', () => {
    expect(shouldCheck({ lastCheckAt: now - CHECK_INTERVAL_MS - 1 }, now)).toBe(true)
  })

  it('lastCheckAt 非法（NaN/负数/未来）判 true', () => {
    expect(shouldCheck({ lastCheckAt: NaN }, now)).toBe(true)
    expect(shouldCheck({ lastCheckAt: -1 }, now)).toBe(true)
    expect(shouldCheck({ lastCheckAt: now + 999_999 }, now)).toBe(true)
  })
})
