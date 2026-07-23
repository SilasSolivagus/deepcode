import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// 同 config.test.ts：src/config.ts 模块加载时就计算 DIR = homedir()/.deepcode，
// 必须在 import 之前把 node:os 的 homedir mock 到临时目录，保证 hermetic。
vi.mock('../src/hooks.js', async orig => ({
  ...(await orig() as any),
  runHooks: vi.fn(async () => ({ block: false, preventContinuation: false, stop: false, results: [] })),
}))

vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>()
  const { mkdtempSync } = await import('node:fs')
  const path = await import('node:path')
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'dc-haskey-'))
  const homedir = () => fakeHome
  return { ...os, homedir, default: { ...os, homedir } }
})

import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { hasApiKey } from '../src/config.js'

const fakeHome = os.homedir()
const settingsFile = path.join(fakeHome, '.deepcode', 'settings.json')

function writeSettings(obj: unknown) {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
  fs.writeFileSync(settingsFile, JSON.stringify(obj))
}

describe('hasApiKey：任意内置 provider key 就绪即为真', () => {
  // 用户真实 shell 环境可能已设 DEEPSEEK_API_KEY 等，测试须 hermetic：每个用例前清空，跑完恢复。
  const ENV_KEYS = ['DEEPSEEK_API_KEY', 'ZHIPUAI_API_KEY', 'MOONSHOT_API_KEY']
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  })

  it('只配 providers.glm.apiKey 也算已配（不再误进 DeepSeek 向导）', () => {
    writeSettings({ providers: { glm: { apiKey: 'zhipu-test-key' } } })
    expect(hasApiKey()).toBe(true)
  })

  it('全空 → false', () => {
    writeSettings({})
    expect(hasApiKey()).toBe(false)
  })

  it('DEEPSEEK_API_KEY env → true', () => {
    writeSettings({})
    process.env.DEEPSEEK_API_KEY = 'sk-from-env'
    expect(hasApiKey()).toBe(true)
    delete process.env.DEEPSEEK_API_KEY
  })
})
