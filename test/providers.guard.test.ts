// test/providers.guard.test.ts —— 跨 provider 错投防护（foreignProviderOf / resolveStartupModel）
import { describe, it, expect } from 'vitest'
import { BUILTIN_PROVIDERS, foreignProviderOf, resolveStartupModel } from '../src/providers.js'

const deepseek = BUILTIN_PROVIDERS.deepseek
const glm = BUILTIN_PROVIDERS.glm

describe('foreignProviderOf', () => {
  it('本 provider 的档不算外来', () => {
    expect(foreignProviderOf(deepseek, 'deepseek-v4-pro')).toBeUndefined()
    expect(foreignProviderOf(glm, 'glm-5.2')).toBeUndefined()
  })

  it('明确归属另一个内置 provider 的档 → 返回那个 provider id', () => {
    expect(foreignProviderOf(glm, 'deepseek-v4-pro')).toBe('deepseek')
    expect(foreignProviderOf(deepseek, 'glm-5.2')).toBe('glm')
  })

  it('无人认领的未知档 → undefined（不误伤 custom provider 与未来新档）', () => {
    expect(foreignProviderOf(deepseek, 'my-local-llama')).toBeUndefined()
    expect(foreignProviderOf(glm, 'my-local-llama')).toBeUndefined()
  })
})

describe('resolveStartupModel', () => {
  it('外来 provider 的档 → 回落 active fast（防静默错投）', () => {
    expect(resolveStartupModel('glm-5.2', deepseek)).toBe(deepseek.models.fast)
    expect(resolveStartupModel('deepseek-v4-pro', glm)).toBe(glm.models.fast)
  })

  it('未配置 → active smart（默认用智能档）', () => {
    expect(resolveStartupModel(undefined, glm)).toBe(glm.models.smart)
    expect(resolveStartupModel(undefined, deepseek)).toBe('deepseek-v4-pro')
  })

  it('本 provider 的档 / 未知档 → 原样保留', () => {
    expect(resolveStartupModel('deepseek-v4-pro', deepseek)).toBe('deepseek-v4-pro')
    expect(resolveStartupModel('my-local-llama', deepseek)).toBe('my-local-llama')
  })
})
