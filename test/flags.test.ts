import { describe, it, expect, afterEach, vi } from 'vitest'
import { flag } from '../src/flags.js'

const ORIG = process.env.DEEPCODE_FLAGS
afterEach(() => {
  if (ORIG === undefined) delete process.env.DEEPCODE_FLAGS
  else process.env.DEEPCODE_FLAGS = ORIG
  vi.restoreAllMocks()
})

describe('flag', () => {
  it('未设 DEEPCODE_FLAGS → 用硬编码默认值', () => {
    delete process.env.DEEPCODE_FLAGS
    expect(flag('verifyMethod', false)).toBe(false)
    expect(flag('somethingOn', true)).toBe(true)
  })

  it('env 里有同名键 → env 覆盖默认值', () => {
    process.env.DEEPCODE_FLAGS = '{"verifyMethod":true}'
    expect(flag('verifyMethod', false)).toBe(true)
    process.env.DEEPCODE_FLAGS = '{"somethingOn":false}'
    expect(flag('somethingOn', true)).toBe(false)
  })

  it('env 里没有该键 → 仍用默认值', () => {
    process.env.DEEPCODE_FLAGS = '{"otherFlag":true}'
    expect(flag('verifyMethod', false)).toBe(false)
  })

  it('非布尔取值一律忽略，退回默认值（不做真值转换）', () => {
    process.env.DEEPCODE_FLAGS = '{"verifyMethod":"true"}'
    expect(flag('verifyMethod', false)).toBe(false)
    process.env.DEEPCODE_FLAGS = '{"verifyMethod":1}'
    expect(flag('verifyMethod', false)).toBe(false)
  })

  it('JSON 非法 → 整体忽略 + 打一行 stderr 警告，不抛出', () => {
    process.env.DEEPCODE_FLAGS = '{不是 JSON'
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    let threw = false
    let v = true
    try { v = flag('verifyMethod', false) } catch { threw = true }
    const warned = spy.mock.calls.map(c => String(c[0])).join('')
    spy.mockRestore()
    expect(threw).toBe(false)
    expect(v).toBe(false)
    expect(warned).toContain('DEEPCODE_FLAGS')
  })

  it('JSON 顶层不是对象 → 同样忽略，不抛出', () => {
    process.env.DEEPCODE_FLAGS = '[1,2,3]'
    expect(() => flag('verifyMethod', false)).not.toThrow()
    expect(flag('verifyMethod', false)).toBe(false)
  })

  it('每次求值都重读 env（同进程内改了 env 立即生效，便于测试注入）', () => {
    delete process.env.DEEPCODE_FLAGS
    expect(flag('x', false)).toBe(false)
    process.env.DEEPCODE_FLAGS = '{"x":true}'
    expect(flag('x', false)).toBe(true)
  })

  it('非法 JSON 只警告一次，不在热路径上刷屏', () => {
    process.env.DEEPCODE_FLAGS = '{坏'
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    for (let i = 0; i < 5; i++) flag('x', false)
    const n = spy.mock.calls.length
    spy.mockRestore()
    expect(n).toBe(1)
  })
})
