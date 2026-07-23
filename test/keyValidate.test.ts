import { describe, it, expect } from 'vitest'
import { validateLlmKey, validateSearchKey, validateVisionKey } from '../src/keyValidate.js'

describe('validateLlmKey', () => {
  it('200 → ok', async () => {
    const fakeClient = { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'hi' } }] }) } } }
    const r = await validateLlmKey({ apiKeyEnvOrKey: 'sk-x', baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-pro' }, { client: fakeClient as any })
    expect(r).toEqual({ ok: true })
  })

  it('401 → ok:false 且含"无效"', async () => {
    const fakeClient = { chat: { completions: { create: async () => { const e: any = new Error('Unauthorized'); e.status = 401; throw e } } } }
    const r = await validateLlmKey({ apiKeyEnvOrKey: 'bad', baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-pro' }, { client: fakeClient as any })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('无效')
  })

  it('403 → ok:false 且含"无效"', async () => {
    const fakeClient = { chat: { completions: { create: async () => { const e: any = new Error('Forbidden'); e.status = 403; throw e } } } }
    const r = await validateLlmKey({ apiKeyEnvOrKey: 'bad', baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-pro' }, { client: fakeClient as any })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('无效')
  })

  it('网络错/超时 → ok:false 且含"超时"或"网络"，不抛', async () => {
    const fakeClient = { chat: { completions: { create: async () => { throw new Error('fetch failed') } } } }
    const r = await validateLlmKey({ apiKeyEnvOrKey: 'x', baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-pro' }, { client: fakeClient as any })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/超时|网络/)
  })

  it('never throws：client 构造/请求任意异常都被吞', async () => {
    const fakeClient = { chat: { completions: { create: async () => { throw 'boom-not-an-error' } } } }
    await expect(validateLlmKey({ apiKeyEnvOrKey: 'x', baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-pro' }, { client: fakeClient as any })).resolves.not.toThrow()
  })
})

describe('validateSearchKey', () => {
  it('bocha 200 → ok', async () => {
    const fetchJson = async () => ({ data: { webPages: { value: [{ name: 't', url: 'https://a.com', snippet: 's' }] } } })
    const r = await validateSearchKey('bocha', 'sk-key', { fetchJson })
    expect(r).toEqual({ ok: true })
  })

  it('bocha 401 → ok:false', async () => {
    const fetchJson = async () => { throw new Error('HTTP 401 Unauthorized') }
    const r = await validateSearchKey('bocha', 'bad', { fetchJson })
    expect(r.ok).toBe(false)
  })

  it('tavily 200 → ok', async () => {
    const fetchJson = async () => ({ results: [{ title: 't', url: 'https://a.com', content: 's' }] })
    const r = await validateSearchKey('tavily', 'tvly-k', { fetchJson })
    expect(r).toEqual({ ok: true })
  })

  it('tavily 401 → ok:false，不抛', async () => {
    const fetchJson = async () => { throw new Error('HTTP 401 Unauthorized') }
    const r = await validateSearchKey('tavily', 'bad', { fetchJson })
    expect(r.ok).toBe(false)
  })
})

describe('validateVisionKey', () => {
  it('200 → ok', async () => {
    const fakeClient = { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'hi' } }] }) } } }
    const r = await validateVisionKey('zk-key', { client: fakeClient as any })
    expect(r).toEqual({ ok: true })
  })

  it('401 → ok:false 且含"无效"', async () => {
    const fakeClient = { chat: { completions: { create: async () => { const e: any = new Error('Unauthorized'); e.status = 401; throw e } } } }
    const r = await validateVisionKey('bad', { client: fakeClient as any })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('无效')
  })

  it('never throws', async () => {
    const fakeClient = { chat: { completions: { create: async () => { throw new Error('boom') } } } }
    await expect(validateVisionKey('x', { client: fakeClient as any })).resolves.not.toThrow()
  })
})
