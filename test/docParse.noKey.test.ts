import { it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/config.js', () => ({ loadSettings: () => ({}) })) // 无 providers

import { parseDocument } from '../src/docParse.js'
import { GlmKeyMissingError } from '../src/imageDescribe.js'

const ENV = 'ZHIPUAI_API_KEY' // 已确认=glm preset 的 apiKeyEnv（src/providers.ts:60）
let saved: string | undefined
beforeEach(() => { saved = process.env[ENV]; delete process.env[ENV] })
afterEach(() => { if (saved !== undefined) process.env[ENV] = saved })

it('无 GLM key → 抛 GlmKeyMissingError', async () => {
  await expect(parseDocument('AAAA', 'application/pdf', { fetchImpl: (async () => ({ ok: true, json: async () => ({}) })) as any }))
    .rejects.toBeInstanceOf(GlmKeyMissingError)
})
