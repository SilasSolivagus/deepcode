import { describe, it, expect, vi, beforeEach } from 'vitest'

// 同 hasApiKey.test.ts：src/config.ts 模块加载时就计算 DIR = homedir()/.deepcode，
// 必须在 import 之前把 node:os 的 homedir mock 到临时目录，保证 hermetic。
// mock runHooks 捕获调用（同 config.test.ts 的模式）。
const hookCalls: Array<{ event: string; payload: any }> = []
vi.mock('../src/hooks.js', async orig => ({
  ...(await orig() as any),
  runHooks: vi.fn(async (event: string, payload: any) => {
    hookCalls.push({ event, payload })
    return { block: false, preventContinuation: false, stop: false, results: [] }
  }),
}))

vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>()
  const { mkdtempSync } = await import('node:fs')
  const path = await import('node:path')
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'dc-savekeys-'))
  const homedir = () => fakeHome
  return { ...os, homedir, default: { ...os, homedir } }
})

import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { saveOnboardingKeys, loadRawUserSettings } from '../src/config.js'

const fakeHome = os.homedir()
const settingsFile = path.join(fakeHome, '.deepcode', 'settings.json')

function writeSettings(obj: unknown) {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
  fs.writeFileSync(settingsFile, JSON.stringify(obj))
}

describe('saveOnboardingKeys：per-provider key 写 user 层（RMW，不写全局 apiKey）', () => {
  it('写 glm provider/model/key + tavily + vision key，读回正确且无全局 apiKey，既有无关字段/兄弟 provider 保留', () => {
    writeSettings({
      theme: 'dark',
      providers: { deepseek: { apiKey: 'sk-old-deepseek' } },
    })

    saveOnboardingKeys({
      provider: 'glm',
      model: 'glm-5.2',
      providerKeys: { glm: 'zk' },
      search: { tavily: 'tv' },
      visionGlmKey: 'zk',
    })

    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    expect(raw.provider).toBe('glm')
    expect(raw.model).toBe('glm-5.2')
    expect(raw.providers.glm.apiKey).toBe('zk')
    expect(raw.webSearch.tavily.apiKey).toBe('tv')
    expect(raw.apiKey).toBeUndefined()
    // 既有无关字段保留
    expect(raw.theme).toBe('dark')
    // 兄弟 provider 未被清掉
    expect(raw.providers.deepseek.apiKey).toBe('sk-old-deepseek')

    const s = loadRawUserSettings()
    expect(s.provider).toBe('glm')
    expect(s.providers?.glm?.apiKey).toBe('zk')
    expect(s.webSearch?.tavily?.apiKey).toBe('tv')
    expect(s.apiKey).toBeUndefined()
  })

  it('custom provider：providerKeys.custom + custom{baseURL,models} 深合并成完整对象', () => {
    writeSettings({})
    saveOnboardingKeys({
      providerKeys: { custom: 'sk-custom' },
      custom: { baseURL: 'https://x/v1', models: { fast: 'a', smart: 'b' } },
    })
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    expect(raw.providers.custom.apiKey).toBe('sk-custom')
    expect(raw.providers.custom.baseURL).toBe('https://x/v1')
    expect(raw.providers.custom.models).toEqual({ fast: 'a', smart: 'b' })
  })

  it('空值/未传字段不覆盖既有值', () => {
    writeSettings({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      providers: { deepseek: { apiKey: 'sk-existing' }, glm: { apiKey: 'zk-existing' } },
      webSearch: { bocha: { apiKey: 'bocha-existing' } },
    })

    saveOnboardingKeys({ providerKeys: { deepseek: '' }, search: { bocha: '' } })

    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    expect(raw.provider).toBe('deepseek')
    expect(raw.model).toBe('deepseek-v4-pro')
    expect(raw.providers.deepseek.apiKey).toBe('sk-existing')
    expect(raw.providers.glm.apiKey).toBe('zk-existing')
    expect(raw.webSearch.bocha.apiKey).toBe('bocha-existing')
  })
})

describe('saveOnboardingKeys Setup hook', () => {
  beforeEach(() => { hookCalls.length = 0 })

  it('已配置 hooks 且此前无任何 key → Setup(trigger=init) 触发', async () => {
    writeSettings({ hooks: { Setup: [{ hooks: [{ type: 'command', command: 'true' }] }] } })
    saveOnboardingKeys({ provider: 'glm', providerKeys: { glm: 'zk' } })
    await new Promise(r => setImmediate(r))
    const setup = hookCalls.find(c => c.event === 'Setup')
    expect(setup).toBeTruthy()
    expect(setup!.payload.trigger).toBe('init')
  })

  it('未配置 hooks → 不触发 Setup', async () => {
    writeSettings({})
    saveOnboardingKeys({ provider: 'glm', providerKeys: { glm: 'zk' } })
    await new Promise(r => setImmediate(r))
    expect(hookCalls.find(c => c.event === 'Setup')).toBeFalsy()
  })

  it('已有落盘 key（per-provider）再改 → Setup(trigger=maintenance)', async () => {
    writeSettings({
      providers: { deepseek: { apiKey: 'sk-old' } },
      hooks: { Setup: [{ hooks: [{ type: 'command', command: 'true' }] }] },
    })
    saveOnboardingKeys({ provider: 'glm', providerKeys: { glm: 'zk' } })
    await new Promise(r => setImmediate(r))
    const setup = hookCalls.find(c => c.event === 'Setup')
    expect(setup).toBeTruthy()
    expect(setup!.payload.trigger).toBe('maintenance')
  })

  it('已有落盤全局 apiKey（遗留字段）再改 → Setup(trigger=maintenance)', async () => {
    writeSettings({
      apiKey: 'sk-old-legacy',
      hooks: { Setup: [{ hooks: [{ type: 'command', command: 'true' }] }] },
    })
    saveOnboardingKeys({ provider: 'glm', providerKeys: { glm: 'zk' } })
    await new Promise(r => setImmediate(r))
    const setup = hookCalls.find(c => c.event === 'Setup')
    expect(setup).toBeTruthy()
    expect(setup!.payload.trigger).toBe('maintenance')
  })
})
