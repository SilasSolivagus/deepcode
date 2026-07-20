// test/providers.crossSwitch.test.ts —— 跨 provider 切换的纯函数底座
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  BUILTIN_PROVIDERS,
  availablePresets,
  providerKeyReady,
  allModelList,
  foreignProviderOf,
  resolveStartupModel,
  providerLabel,
} from '../src/providers.js'
import type { Settings } from '../src/config.js'

const base = { provider: 'deepseek' } as unknown as Settings

afterEach(() => { vi.unstubAllEnvs() })

describe('availablePresets', () => {
  it('默认给出全部内置 preset', () => {
    const ids = availablePresets(base).map(p => p.id)
    expect(ids).toContain('deepseek')
    expect(ids).toContain('glm')
  })

  it('custom 配置完整时一并列出（baseURL+models 齐备）', () => {
    const s = {
      ...base,
      providers: { custom: { baseURL: 'https://x.test/v1', models: { fast: 'x-fast', smart: 'x-smart' } } },
    } as unknown as Settings
    expect(availablePresets(s).map(p => p.id)).toContain('custom')
  })

  it('custom 配置不全时不列出（防选中后回落 deepseek 的静默错投）', () => {
    const s = { ...base, providers: { custom: { baseURL: 'https://x.test/v1' } } } as unknown as Settings
    expect(availablePresets(s).map(p => p.id)).not.toContain('custom')
  })
})

describe('providerKeyReady（镜像 api.ts createClient 的取 key 顺序）', () => {
  it('env 有 key → ready', () => {
    vi.stubEnv('ZHIPUAI_API_KEY', 'k')
    expect(providerKeyReady(BUILTIN_PROVIDERS.glm, base)).toBe(true)
  })

  it('settings.providers.<id>.apiKey 有 key → ready', () => {
    vi.stubEnv('ZHIPUAI_API_KEY', '')
    const s = { ...base, providers: { glm: { apiKey: 'k' } } } as unknown as Settings
    expect(providerKeyReady(BUILTIN_PROVIDERS.glm, s)).toBe(true)
  })

  it('都没有 → 不 ready', () => {
    vi.stubEnv('ZHIPUAI_API_KEY', '')
    expect(providerKeyReady(BUILTIN_PROVIDERS.glm, base)).toBe(false)
  })

  // C1：全局 settings.apiKey 是单 provider 时代的遗留（首跑向导 config.ts saveApiKey 写的就是它）。
  // 若把它当作别家 provider 的 key，切过去后 createClient 会把这家的密钥发给另一家的端点（凭证外泄 + 401）。
  it('全局 settings.apiKey 不能让「别家」provider 显示 ready', () => {
    vi.stubEnv('ZHIPUAI_API_KEY', '')
    const s = { ...base, apiKey: 'sk-deepseek-key' } as unknown as Settings
    expect(providerKeyReady(BUILTIN_PROVIDERS.glm, s)).toBe(false)
  })

  it('全局 settings.apiKey 对 deepseek 仍然算 ready（向导写的就是它，不能破坏既有配置）', () => {
    const s = { ...base, apiKey: 'sk-deepseek-key' } as unknown as Settings
    expect(providerKeyReady(BUILTIN_PROVIDERS.deepseek, s)).toBe(true)
  })

  // 回归：全局 key 若绑「当前 active provider」而非绑「归属者 deepseek」，会造成单向门——
  // 向导装机的用户切到 GLM 后，deepseek 变成"未配置"，再也切不回来（可 api.ts 明明能用那把 key）。
  it('切到 GLM 之后，deepseek 仍然 ready（全局 key 归属 deepseek，不是归属"当前"）', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const s = { provider: 'glm', apiKey: 'sk-deepseek-legacy', providers: { glm: { apiKey: 'zk' } } } as unknown as Settings
    expect(providerKeyReady(BUILTIN_PROVIDERS.deepseek, s)).toBe(true)
  })
})

describe('foreignProviderOf 认得 custom（presets 可注入）', () => {
  it('custom 的档在 active=deepseek 时算外来（否则会被当未知档静默错投）', () => {
    const s = {
      ...base,
      providers: { custom: { baseURL: 'https://x.test/v1', models: { fast: 'x-fast', smart: 'x-smart' } } },
    } as unknown as Settings
    expect(foreignProviderOf(BUILTIN_PROVIDERS.deepseek, 'x-fast', availablePresets(s))).toBe('custom')
  })
})

describe('resolveStartupModel 认得 custom（presets 传入时）', () => {
  it('custom 的档在 active=deepseek 时回落 fast，而非当未知档放行到 deepseek 端点', () => {
    const s = {
      ...base,
      providers: { custom: { baseURL: 'https://x.test/v1', models: { fast: 'x-fast', smart: 'x-smart' } } },
    } as unknown as Settings
    expect(resolveStartupModel('x-fast', BUILTIN_PROVIDERS.deepseek, availablePresets(s)))
      .toBe(BUILTIN_PROVIDERS.deepseek.models.fast)
  })
})

describe('allModelList', () => {
  it('当前 provider 的档在前，其它 provider 的档随后并带 providerId', () => {
    vi.stubEnv('ZHIPUAI_API_KEY', 'k')
    const items = allModelList(base, 'deepseek-v4-flash')
    const ids = items.map(i => i.id)
    expect(ids).toContain('deepseek-v4-flash')
    expect(ids).toContain('glm-5.2')
    const glmItem = items.find(i => i.id === 'glm-5.2')!
    expect(glmItem.providerId).toBe('glm')
    expect(glmItem.ready).toBe(true)
    // 当前 provider 的档排在外来档之前
    expect(ids.indexOf('deepseek-v4-flash')).toBeLessThan(ids.indexOf('glm-5.2'))
  })

  it('目标 provider 没配 key → ready=false 且标签点明缺哪个 env', () => {
    vi.stubEnv('ZHIPUAI_API_KEY', '')
    const glmItem = allModelList(base, 'deepseek-v4-flash').find(i => i.id === 'glm-5.2')!
    expect(glmItem.ready).toBe(false)
    expect(glmItem.label).toContain('ZHIPUAI_API_KEY')
  })
})

describe('providerLabel', () => {
  it('内置 provider 给出展示名，未知 id 原样返回', () => {
    expect(providerLabel('deepseek')).toBe('DeepSeek')
    expect(providerLabel('glm')).toBe('GLM')
    expect(providerLabel('whatever')).toBe('whatever')
  })
})
