// test/providers.availableModels.test.ts —— availableModels 白名单钳制（非剥离）resolveStartupModel
import { describe, it, expect } from 'vitest'
import { BUILTIN_PROVIDERS, resolveStartupModel, modelFallbackReason } from '../src/providers.js'
import { DANGEROUS_TOP_KEYS, stripUntrustedScope } from '../src/settingsLayers.js'

const preset = BUILTIN_PROVIDERS.deepseek // fast='deepseek-v4-flash'、smart='deepseek-v4-pro'

describe('availableModels 白名单', () => {
  it('未设白名单 → 全允许（不改变现有行为）', () => {
    expect(resolveStartupModel('deepseek-v4-flash', preset, undefined, undefined)).toBe('deepseek-v4-flash')
  })

  it('在白名单内 → 生效', () => {
    expect(resolveStartupModel('deepseek-v4-flash', preset, undefined, ['deepseek-v4-flash'])).toBe('deepseek-v4-flash')
  })

  it('不在白名单内 → 忽略，回落到默认档（不是硬失败）', () => {
    // configured 必须不等于 preset.models.smart，否则删掉钳制行返回值不变、这条测不出东西
    expect(resolveStartupModel('deepseek-v4-flash', preset, undefined, ['deepseek-v4-pro'])).toBe(preset.models.smart)
  })

  it('空数组 → 只允许默认档', () => {
    expect(resolveStartupModel('deepseek-v4-flash', preset, undefined, [])).toBe(preset.models.smart)
  })

  it('未配置 model 时白名单不干预', () => {
    expect(resolveStartupModel(undefined, preset, undefined, ['x'])).toBe(preset.models.smart)
  })

  it('白名单自身必须是不可信来源剥离项——否则恶意 project 可自设白名单架空 clamp', () => {
    expect((DANGEROUS_TOP_KEYS as readonly string[])).toContain('availableModels')
    const { raw, stripped } = stripUntrustedScope({ availableModels: ['expensive-model'] })
    expect(raw.availableModels).toBeUndefined()
    expect(stripped).toContain('availableModels')
  })
})

// headless / 后台会话 / TUI 三个入口共用同一份判定与措辞（modelFallbackReason），
// 而非各写各的——否则白名单语义变更时会静默分叉（同一模型一处放行、另一处被拦）。
describe('modelFallbackReason（headless/backgroundRunner/useChat 共享的回落原因判定）', () => {
  it('白名单钳制导致回落 → 白名单专属文案', () => {
    expect(modelFallbackReason('deepseek-v4-flash', preset.models.smart, preset, ['deepseek-v4-pro']))
      .toBe('deepseek-v4-flash 不在 availableModels 白名单内，已回落到 deepseek-v4-pro')
  })

  it('跨 provider 导致回落（未设白名单）→ 通用「不属于当前 provider」文案', () => {
    expect(modelFallbackReason('glm-5.2', preset.models.fast, preset, undefined))
      .toBe('glm-5.2 不属于当前 provider（deepseek），已回落到 deepseek-v4-flash')
  })

  it('resolved 与 requested 相同（未回落）→ undefined', () => {
    expect(modelFallbackReason('deepseek-v4-flash', 'deepseek-v4-flash', preset, ['deepseek-v4-pro'])).toBeUndefined()
  })

  it('requested 未配置 → undefined（不误报回落）', () => {
    expect(modelFallbackReason(undefined, preset.models.smart, preset, ['x'])).toBeUndefined()
  })
})
