import { describe, it, expect } from 'vitest'
import { parseWebSearchConfig } from '../src/config.js'

describe('parseWebSearchConfig anysearch 分支', () => {
  it('enabled:false 必须保留（不被 falsy 丢掉）', () => {
    const c = parseWebSearchConfig({ anysearch: { enabled: false } })
    expect(c?.anysearch).toEqual({ enabled: false })
  })
  it('缺省 enabled → true', () => {
    const c = parseWebSearchConfig({ anysearch: {} })
    expect(c?.anysearch?.enabled).toBe(true)
  })
  it('带 apiKey', () => {
    const c = parseWebSearchConfig({ anysearch: { enabled: true, apiKey: 'ak' } })
    expect(c?.anysearch).toEqual({ enabled: true, apiKey: 'ak' })
  })
  it('bocha 现有解析不受影响', () => {
    expect(parseWebSearchConfig({ bocha: { apiKey: 'b' } })?.bocha).toEqual({ apiKey: 'b' })
  })
})
