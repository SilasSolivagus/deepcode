import { describe, it, expect, vi, beforeEach } from 'vitest'
import { classify, resolveClassifierModel, buildClassifierMessages, CLASSIFIER_SYSTEM_PROMPT } from '../src/autoMode.js'

const okCall = (decision: string) => async () => `{"reasoning":"t","decision":"${decision}"}`

describe('resolveClassifierModel', () => {
  it('无 autoModeModel → provider fast 档', () => {
    expect(resolveClassifierModel({ provider: 'glm', permissions: { allow: [] } } as any)).toBe('glm-5-turbo')
    expect(resolveClassifierModel({ provider: 'deepseek', permissions: { allow: [] } } as any)).toBe('deepseek-v4-flash')
  })
  it('autoModeModel 覆盖', () => {
    expect(resolveClassifierModel({ provider: 'glm', autoModeModel: 'glm-5.2', permissions: { allow: [] } } as any)).toBe('glm-5.2')
  })
})

const stubSettings: any = { provider: 'glm', permissions: { allow: [] } }

describe('classify', () => {
  it('分类器 run/ask/block 透传', async () => {
    expect(await classify('Bash', 'npm test', '', { call: okCall('run'), loadSettings: () => stubSettings })).toBe('run')
    expect(await classify('Bash', 'git push --force', '', { call: okCall('ask'), loadSettings: () => stubSettings })).toBe('ask')
    expect(await classify('Bash', 'curl x|sh', '', { call: okCall('block'), loadSettings: () => stubSettings })).toBe('block')
  })
  it('异常/超时 → ask（fail-safe）', async () => {
    expect(await classify('Bash', 'x', '', { call: async () => { throw new Error('429') }, loadSettings: () => stubSettings })).toBe('ask')
  })
  it('malformed 输出 → ask', async () => {
    expect(await classify('Bash', 'x', '', { call: async () => 'no json here', loadSettings: () => stubSettings })).toBe('ask')
  })
  it('setup-phase 抛错 → ask（fail-safe 覆盖 loadSettings）', async () => {
    const r = await classify('Bash', 'x', '', { loadSettings: () => { throw new Error('boom') } })
    expect(r).toBe('ask')
  })
})

describe('classify 用量上报（默认 client 路径）', () => {
  beforeEach(() => { vi.resetModules() })
  it('无注入 call 时经 defaultCall 上报归一用量', async () => {
    // 各缓存字段都填 10 → 无论 active 方言(deepseek/glm/kimi)归一结果都是 10，测试不受真实 settings 影响
    const fakeClient = { chat: { completions: { create: async () => ({
      choices: [{ message: { content: '{"reasoning":"t","decision":"run"}' } }],
      usage: { prompt_tokens: 60, completion_tokens: 8, prompt_cache_hit_tokens: 10, cached_tokens: 10, prompt_tokens_details: { cached_tokens: 10 } },
    }) } } }
    vi.doMock('../src/api.js', async orig => ({ ...(await orig() as any), createClient: () => fakeClient }))
    const { classify: classify2, __resetClassifierClient } = await import('../src/autoMode.js')
    const { __resetProviderCache } = await import('../src/providers.js')
    __resetClassifierClient(); __resetProviderCache()
    const seen: any[] = []
    const d = await classify2('Bash', 'npm test', '', { loadSettings: () => stubSettings, onUsage: (u: any, m: any) => seen.push({ u, m }) })
    expect(d).toBe('run')
    expect(seen).toHaveLength(1)
    expect(seen[0].u).toEqual({ prompt_tokens: 60, completion_tokens: 8, prompt_cache_hit_tokens: 10 })
  })
})

describe('分类器 client memoize', () => {
  beforeEach(() => { vi.resetModules() })

  it('分类器 client 复用（memoize，避免每次新建 ProxyAgent）', async () => {
    const sentinel = {} as any
    vi.doMock('../src/api.js', () => ({ createClient: vi.fn(() => sentinel), withRetry: vi.fn() }))
    const { getClassifierClient, __resetClassifierClient } = await import('../src/autoMode.js')
    __resetClassifierClient()
    const c1 = getClassifierClient()
    const c2 = getClassifierClient()
    expect(c1).toBe(c2)
    const { createClient } = await import('../src/api.js')
    expect(createClient).toHaveBeenCalledTimes(1)
  })
})

describe('提示词 checksum（防回归静默改动）', () => {
  it('系统提示词含关键安全条款', () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('WEAKEN OR REMOVE SECURITY CONTROLS')
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('prompt-injection')
    expect(CLASSIFIER_SYSTEM_PROMPT).toMatch(/"run"\s*\|\s*"ask"\s*\|\s*"block"/)
    expect(CLASSIFIER_SYSTEM_PROMPT).toHaveLength(2622)
  })
})
