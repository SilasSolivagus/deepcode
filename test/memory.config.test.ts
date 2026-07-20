import { describe, test, expect } from 'vitest'
import { parseMemoryConfig, DEFAULT_MEMORY_CONFIG } from '../src/memdir/memoryConfig.js'

test('空/非对象 → 全默认', () => {
  expect(parseMemoryConfig(undefined)).toEqual(DEFAULT_MEMORY_CONFIG)
  expect(parseMemoryConfig('x')).toEqual(DEFAULT_MEMORY_CONFIG)
  expect(parseMemoryConfig({})).toEqual(DEFAULT_MEMORY_CONFIG)
})
test('部分覆盖 + 非法字段丢弃回默认', () => {
  const c = parseMemoryConfig({ enabled: false, extractEveryTurns: 'x', dream: { minHours: 1 } })
  expect(c.enabled).toBe(false)
  expect(c.extractEveryTurns).toBe(1) // 非法→默认
  expect(c.dream.minHours).toBe(1)
  expect(c.dream.minSessions).toBe(5)
})
test('默认值正确', () => {
  expect(DEFAULT_MEMORY_CONFIG).toEqual({
    enabled: true, extractEveryTurns: 1,
    sessionMemory: { enabled: true, minInitTokens: 10000, minUpdateTokens: 5000, toolCallsBetween: 3 },
    dream: { enabled: true, minHours: 24, minSessions: 5 },
    global: { enabled: true, maxBytes: 8192 },
    indexConsolidation: { enabled: true },
  })
})

describe('memory.global 配置', () => {
  test('默认启用、预算 8192', () => {
    const c = parseMemoryConfig(undefined)
    expect(c.global.enabled).toBe(true)
    expect(c.global.maxBytes).toBe(8192)
  })
  test('可覆盖，坏值回落默认', () => {
    expect(parseMemoryConfig({ global: { enabled: false, maxBytes: 4096 } }).global).toEqual({ enabled: false, maxBytes: 4096 })
    expect(parseMemoryConfig({ global: { maxBytes: -1 } }).global.maxBytes).toBe(8192)
    expect(parseMemoryConfig({ global: 'nope' }).global.enabled).toBe(true)
  })
})
