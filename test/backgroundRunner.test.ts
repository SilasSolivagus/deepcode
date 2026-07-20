// test/backgroundRunner.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// 脚本化的 chatStream（对齐 test/loop.test.ts、test/headless.test.ts 既有 mock 形状）：
// runLoop 通过 src/api.js 的 chatStream 驱动，而非直接调 client.chat.completions.create。
const script: Array<{ result: any }> = []
vi.mock('../src/api.js', () => ({
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      return scene.result
    })(),
  ),
}))

const mockSettings = {
  permissions: { allow: [] },
  maxToolResultChars: 100_000,
}
vi.mock('../src/settingsLayers.js', async orig => {
  const actual = await orig<typeof import('../src/settingsLayers.js')>()
  return {
    ...actual,
    loadLayeredSettings: vi.fn(() => ({
      settings: mockSettings,
      provenance: {},
      permissionSources: { allow: {}, deny: {} },
      scopes: [],
    })),
  }
})

import { newSession } from '../src/session.js'
import { writeJobState, readJobState } from '../src/backgroundSession.js'
import { runBackgroundSession } from '../src/backgroundRunner.js'
import { chatStream } from '../src/api.js'

const usage = { prompt_tokens: 5, completion_tokens: 3, prompt_cache_hit_tokens: 0 }

let tmp: string, sessDir: string
beforeEach(() => {
  script.length = 0
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-bgrun-'))
  process.env.DEEPCODE_TEST_HOME = tmp
  sessDir = path.join(tmp, 'sessions')
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DEEPCODE_TEST_HOME
})

function seedSession(): { file: string; short: string } {
  const h = newSession({ cwd: tmp, model: 'glm-5.2', thinking: false, permMode: 'default' }, sessDir)
  h.appendMessage({ role: 'system', content: 'sys' })
  h.appendMessage({ role: 'user', content: '先前的问题' }, 1)
  const short = path.basename(h.file).replace(/\.jsonl$/, '').slice(0, 8)
  return { file: h.file, short }
}

describe('runBackgroundSession', () => {
  it('resume 会话跑到 done → state completed，新消息落回同一文件', async () => {
    const { file, short } = seedSession()
    writeJobState({
      sessionId: path.basename(file).replace(/\.jsonl$/, ''), short, state: 'working', cwd: tmp,
      name: 'x', pid: process.pid, model: 'glm-5.2', permMode: 'default', sessionFile: file,
      backend: 'detached', createdAt: 1, updatedAt: 1,
    })
    script.push({ result: { content: '后台跑完了', toolCalls: [], usage, finishReason: 'stop' } })
    await runBackgroundSession({ client: {} as any, resumeFile: file, jobShort: short, seed: '继续干', home: tmp })
    expect(readJobState(short)?.state).toBe('completed')
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).toContain('继续干')        // seed 落盘
    expect(raw).toContain('后台跑完了')     // assistant 回复落盘
  })

  it('permissions.ask 命中路径在后台会话下仍被拦截，不被只读短路静默放行', async () => {
    ;(mockSettings.permissions as any).ask = ['**/.env']
    try {
      const { file, short } = seedSession()
      writeJobState({
        sessionId: path.basename(file).replace(/\.jsonl$/, ''), short, state: 'working', cwd: tmp,
        name: 'x', pid: process.pid, model: 'glm-5.2', permMode: 'default', sessionFile: file,
        backend: 'detached', createdAt: 1, updatedAt: 1,
      })
      script.push({
        result: {
          content: '', toolCalls: [{ id: 'ra1', name: 'Read', args: JSON.stringify({ file_path: '.env' }) }],
          usage, finishReason: 'tool_calls',
        },
      })
      script.push({ result: { content: '完成', toolCalls: [], usage, finishReason: 'stop' } })
      await runBackgroundSession({ client: {} as any, resumeFile: file, jobShort: short, seed: '读一下 .env', yolo: true, home: tmp })
      expect(readJobState(short)?.state).toBe('completed')
      const raw = fs.readFileSync(file, 'utf8')
      expect(raw).toContain('ask 规则')
    } finally {
      delete (mockSettings.permissions as any).ask
    }
  })

  it('client 抛错 → state failed', async () => {
    const { file, short } = seedSession()
    writeJobState({
      sessionId: path.basename(file).replace(/\.jsonl$/, ''), short, state: 'working', cwd: tmp,
      name: 'x', pid: process.pid, model: 'glm-5.2', permMode: 'default', sessionFile: file,
      backend: 'detached', createdAt: 1, updatedAt: 1,
    })
    // 不 push script → mock chatStream 抛 'script exhausted'（对齐 test/loop.test.ts:717 的异常路径手法）
    await runBackgroundSession({ client: {} as any, resumeFile: file, jobShort: short, seed: 'x', home: tmp })
    expect(readJobState(short)?.state).toBe('failed')
  })

  // opus 评审 I2：后台会话（/background 送后台跑）此前不注入全局记忆抽屉——
  // 恰恰是用户看不见、真在写代码的路径，红线偏好不能静默失效。
  it('全局记忆抽屉：新建（空）会话首条系统消息含全局记忆全文', async () => {
    const globalMemDir = path.join(tmp, '.deepcode', 'memory')
    fs.mkdirSync(globalMemDir, { recursive: true })
    fs.writeFileSync(path.join(globalMemDir, 'tw.md'), '---\ntype: user\n---\n不喜欢 tailwind。')

    // newSession 只写 meta，不写任何消息 → 命中 backgroundRunner.ts 现场构建系统提示的分支
    const h = newSession({ cwd: tmp, model: 'glm-5.2', thinking: false, permMode: 'default' }, sessDir)
    const short = path.basename(h.file).replace(/\.jsonl$/, '').slice(0, 8)
    writeJobState({
      sessionId: path.basename(h.file).replace(/\.jsonl$/, ''), short, state: 'working', cwd: tmp,
      name: 'x', pid: process.pid, model: 'glm-5.2', permMode: 'default', sessionFile: h.file,
      backend: 'detached', createdAt: 1, updatedAt: 1,
    })
    script.push({ result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })

    await runBackgroundSession({ client: {} as any, resumeFile: h.file, jobShort: short, seed: 'hi', home: tmp })

    const call = vi.mocked(chatStream).mock.calls.at(-1)
    expect(call).toBeDefined()
    const sysMsg = call![1].messages[0]
    expect(sysMsg.role).toBe('system')
    expect(sysMsg.content).toContain('不喜欢 tailwind。')
  })
})
