import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'

vi.mock('../src/config.js', () => ({ saveOnboardingKeys: vi.fn() }))
vi.mock('../src/keyValidate.js', () => ({
  validateLlmKey: vi.fn(),
  validateSearchKey: vi.fn(),
  validateVisionKey: vi.fn(),
}))

import { Setup } from '../src/tui/setup.js'
import * as config from '../src/config.js'
import * as keyValidate from '../src/keyValidate.js'

const delay = (ms = 20) => new Promise(r => setTimeout(r, ms))

describe('Setup 多步向导', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('快乐路径：DeepSeek（默认）+ LLM key + 跳过搜索 + vision key → saveOnboardingKeys 调用形状正确', async () => {
    vi.mocked(keyValidate.validateLlmKey).mockResolvedValue({ ok: true })
    vi.mocked(keyValidate.validateVisionKey).mockResolvedValue({ ok: true })
    const onDone = vi.fn()
    const { stdin } = render(<Setup onDone={onDone} />)
    await delay()

    // provider 步：默认选中 DeepSeek，直接 Enter
    stdin.write('\r')
    await delay()

    // llmKey 步：录 key
    stdin.write('sk-test-key')
    await delay()
    stdin.write('\r')
    await delay(30)

    // search 步：Bocha/Tavily 都 Enter 跳过
    stdin.write('\r')
    await delay()
    stdin.write('\r')
    await delay()

    // vision 步：录 key
    stdin.write('zk-vision-key')
    await delay()
    stdin.write('\r')
    await delay(30)

    expect(config.saveOnboardingKeys).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(config.saveOnboardingKeys).mock.calls[0][0]
    expect(arg.provider).toBe('deepseek')
    expect(arg.providerKeys?.deepseek).toBe('sk-test-key')
    expect(arg.visionGlmKey).toBe('zk-vision-key')
    expect(arg.search).toBeUndefined()

    // done 步：任意键 → onDone
    stdin.write('\r')
    await delay()
    expect(onDone).toHaveBeenCalled()
  })

  it('验证失败：显示"仍然保存"提示，按 s 后流程继续（不卡死）', async () => {
    vi.mocked(keyValidate.validateLlmKey).mockResolvedValue({ ok: false, error: 'API key 无效或无权限' })
    const { stdin, lastFrame } = render(<Setup onDone={() => {}} />)
    await delay()

    stdin.write('\r') // provider：默认 DeepSeek
    await delay()

    stdin.write('sk-bad-key')
    await delay()
    stdin.write('\r')
    await delay(30)

    expect(lastFrame()).toContain('仍然保存')

    stdin.write('s')
    await delay()

    // 流程继续进入下一步（搜索步文案），不再停在 llmKey 错误页
    expect(lastFrame()).not.toContain('仍然保存')
    expect(lastFrame()).toContain('Bocha')
  })

  it('GLM 复用：选 GLM 后 vision 步被自动跳过，visionGlmKey 复用 llmKey', async () => {
    vi.mocked(keyValidate.validateLlmKey).mockResolvedValue({ ok: true })
    const { stdin } = render(<Setup onDone={() => {}} />)
    await delay()

    stdin.write('\x1B[B') // ↓ 选中 GLM
    await delay()
    stdin.write('\r')
    await delay()

    stdin.write('glm-key-123')
    await delay()
    stdin.write('\r')
    await delay(30)

    // search 步两次 Enter 跳过
    stdin.write('\r')
    await delay()
    stdin.write('\r')
    await delay(30)

    // vision 步应已自动跳过：saveOnboardingKeys 已被调用（无需再录 vision key）
    expect(config.saveOnboardingKeys).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(config.saveOnboardingKeys).mock.calls[0][0]
    expect(arg.provider).toBe('glm')
    expect(arg.visionGlmKey).toBe('glm-key-123')
  })
})
