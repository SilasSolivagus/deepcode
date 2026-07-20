// test/useChat.vision.test.ts —— Task 5：send 视觉分叉（原生透传 vs describe 降级）
// 通过 createChatCore 集成驱动：mock '../src/loop.js' 的 runLoop 捕获 send 落盘的 messages，
// 断言 turn 内构造的 user 消息是否带 images 旁挂；mock providers/imageDescribe/imageResize 控制分支与副作用。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

type Scene = { prompt_tokens?: number }
const script: Scene[] = []
let capturedMessages: any[] = []
vi.mock('../src/loop.js', async orig => ({
  ...(await orig() as any),
  runLoop: vi.fn((messages: any[]) => {
    capturedMessages = messages
    return (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('runLoop script exhausted')
      const sentLen = messages.length
      yield {
        type: 'turn_end',
        usage: { prompt_tokens: scene.prompt_tokens ?? 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 },
        sentLen,
      }
      return undefined
    })()
  }),
}))

const activeModelMetaMock = vi.fn()
vi.mock('../src/providers.js', async orig => ({
  ...(await orig() as any),
  activeModelMeta: (id: string) => activeModelMetaMock(id),
}))

const describeImageMock = vi.fn(async (_img: { base64: string; mime: string }, _userText: string) => '图中文字描述')
vi.mock('../src/imageDescribe.js', async orig => ({
  ...(await orig() as any),
  describeImage: (img: { base64: string; mime: string }, userText: string) => describeImageMock(img, userText),
}))

const normalizeForVisionMock = vi.fn(async (base64: string, mime: string) => ({ base64: `resized:${base64}`, mime }))
vi.mock('../src/imageResize.js', async orig => ({
  ...(await orig() as any),
  normalizeForVision: (base64: string, mime: string) => normalizeForVisionMock(base64, mime),
}))

import { createChatCore } from '../src/tui/useChat.js'

let sessionDir: string
let cwd: string
let home: string
let settingsPath: string
const writeSettings = (obj: any) => writeFileSync(settingsPath, JSON.stringify(obj))

beforeEach(() => {
  script.length = 0
  capturedMessages = []
  vi.clearAllMocks()
  describeImageMock.mockResolvedValue('图中文字描述')
  normalizeForVisionMock.mockImplementation(async (base64: string, mime: string) => ({ base64: `resized:${base64}`, mime }))
  sessionDir = mkdtempSync(path.join(tmpdir(), 'deepcode-vision-session-'))
  cwd = mkdtempSync(path.join(tmpdir(), 'deepcode-vision-cwd-'))
  home = mkdtempSync(path.join(tmpdir(), 'deepcode-vision-home-'))
  settingsPath = path.join(cwd, 'flag-settings.json')
  writeSettings({})
})
afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

const mkCore = () => createChatCore({
  client: {} as any, yolo: true, cwd, sessionDir, home, flagSettingsPath: settingsPath,
  onState: () => {}, runSubagent: vi.fn(async () => 'ok'),
})

const image = (id = 1) => ({ id, type: 'image' as const, base64: 'BASE64DATA', mime: 'image/png', source: 'file' as const })
const lastUserMsg = () => capturedMessages.filter(m => m.role === 'user').at(-1)

describe('send 视觉分叉（Task 5）', () => {
  it('supportsVision=true：user 消息带 images 旁挂，describeImage 零调用', async () => {
    activeModelMetaMock.mockReturnValue({ hit: 0, miss: 0, out: 0, contextWindow: 128_000, supportsThinking: true, supportsVision: true })
    script.push({ prompt_tokens: 0 })
    const core = mkCore()
    await core.send('图里写了什么 [Image #1]', [image()])
    await new Promise(r => setTimeout(r, 20))

    expect(describeImageMock).not.toHaveBeenCalled()
    expect(normalizeForVisionMock).toHaveBeenCalledWith('BASE64DATA', 'image/png')
    const msg = lastUserMsg()
    expect(msg).toBeTruthy()
    expect(msg.images).toEqual([{ base64: 'resized:BASE64DATA', mime: 'image/png' }])
    // 占位符保留（原生路径不 describe 注入文字，仅展开文本占位）
    expect(msg.content).toContain('[Image #1]')
    core.dispose()
  })

  it('supportsVision=false（默认）：describeImage 被调用，user 消息无 images 旁挂', async () => {
    activeModelMetaMock.mockReturnValue({ hit: 0, miss: 0, out: 0, contextWindow: 128_000, supportsThinking: false })
    script.push({ prompt_tokens: 0 })
    const core = mkCore()
    await core.send('图里写了什么 [Image #1]', [image()])
    await new Promise(r => setTimeout(r, 20))

    expect(describeImageMock).toHaveBeenCalledTimes(1)
    expect(normalizeForVisionMock).not.toHaveBeenCalled()
    const msg = lastUserMsg()
    expect(msg).toBeTruthy()
    expect(msg.images).toBeUndefined()
    core.dispose()
  })
})
