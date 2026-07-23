import { describe, it, expect } from 'vitest'
import { contextWindowFor } from '../src/providers.js'

describe('contextWindowFor — 按归属 provider 解析窗口（不受 active provider 影响）', () => {
  it('deepseek-v4-pro 恒 1M（归属 deepseek，即便 active 是别家）', () => {
    // deepseek 在 BUILTIN_PROVIDERS 里被 belongsToProvider 命中，先于 active 兜底，故与 active 无关
    expect(contextWindowFor('deepseek-v4-pro')).toBe(1_000_000)
  })
  it('glm-5.2 恒 1M（归属 glm）', () => {
    expect(contextWindowFor('glm-5.2')).toBe(1_000_000)
  })
  it('未知 id 回落 active provider defaultMeta（不抛）', () => {
    expect(contextWindowFor('totally-unknown-model')).toBeGreaterThan(0)
  })
})
