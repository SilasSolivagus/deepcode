// test/useChat.activity.test.ts —— Task 6：活动日志 writer 在 useChat 的接线
// 三条重放路径（compact / fork / background）必须 suppress，否则同一段活动被重复摘要，污染 dream 语料。
// displayText 反向默认：只有真正的用户输入路径记展开后的 userText，斜杠命令只记命令名。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// memdir 重定向到临时目录：活动日志、记忆提取都写这里，不碰真实 ~/.deepcode
let memRoot: string
vi.mock('../src/memdir/paths.js', async orig => {
  const actual = await orig<typeof import('../src/memdir/paths.js')>()
  return { ...actual, memdirFor: () => memRoot }
})

const script: Array<{ result: any }> = []
vi.mock('../src/api.js', async orig => ({
  ...(await orig() as any),
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      return scene.result
    })(),
  ),
}))

// summarize：/compact 不真打 API
vi.mock('../src/compact.js', async orig => ({
  ...(await orig() as any),
  summarize: vi.fn(async () => ({
    summary: '历史总结', usage: { prompt_tokens: 5, completion_tokens: 5, prompt_cache_hit_tokens: 0 }, truncated: false,
  })),
}))

import { createChatCore } from '../src/tui/useChat.js'
import { INIT_PROMPT } from '../src/commands.js'

const usage = { prompt_tokens: 50, completion_tokens: 20, prompt_cache_hit_tokens: 40 }
const say = (content: string) => script.push({ result: { content, toolCalls: [], usage, finishReason: 'stop' } })

let sessionDir: string, cwd: string, settingsPath: string, home: string
beforeEach(() => {
  script.length = 0
  vi.clearAllMocks()
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-act-sess-'))
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-act-cwd-'))
  memRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-act-mem-'))
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-act-home-'))
  process.env.DEEPCODE_TEST_HOME = home // job state 落临时目录
  settingsPath = path.join(cwd, 'flag-settings.json')
  fs.writeFileSync(settingsPath, JSON.stringify({
    memory: { enabled: true, dream: { enabled: false } },
  }))
})
afterEach(() => {
  delete process.env.DEEPCODE_TEST_HOME
  for (const d of [sessionDir, cwd, memRoot, home]) fs.rmSync(d, { recursive: true, force: true })
})

const mkCore = (extra: Record<string, any> = {}) => createChatCore({
  client: {} as any, yolo: true, cwd, sessionDir, flagSettingsPath: settingsPath,
  onState: () => {}, runSubagent: vi.fn(async () => 'ok'), ...extra,
})

/** memRoot/logs 下所有 .md（按路径排序，稳定）。 */
const logFiles = (): string[] => {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      if (e.isDirectory()) walk(f)
      else if (e.name.endsWith('.md')) out.push(f)
    }
  }
  try { walk(path.join(memRoot, 'logs')) } catch { /* 还没有日志 */ }
  return out.sort()
}
const logText = (i = 0) => fs.readFileSync(logFiles()[i], 'utf8')
const count = (txt: string, re: RegExp) => (txt.match(re) ?? []).length

describe('Task 6 活动日志接线', () => {
  it('新会话：用户原话与助手结论写进活动日志', async () => {
    const core = mkCore()
    say('干完了')
    await core.send('把这件事办了')
    core.dispose()

    expect(logFiles().length).toBe(1)
    const txt = logText()
    expect(txt).toContain('> 把这件事办了')
    expect(txt).toContain('< 干完了')
    expect(txt).toContain(`cwd: ${cwd}`)
  })

  it('斜杠命令只记命令名，不把指导语当成用户原话（displayText 反向默认）', async () => {
    const core = mkCore()
    say('好的')
    await core.send('/init')
    core.dispose()

    const txt = logText()
    expect(txt).toContain('> /init')
    expect(txt).not.toContain(INIT_PROMPT.trim().slice(0, 40)) // INIT_PROMPT 正文不得入日志
  })

  it('compact 重放不重复摘要，并留下 ~ compact 事件', async () => {
    const core = mkCore()
    say('结论 A')
    await core.send('原始诉求')
    await core.send('/compact')
    core.dispose()

    const txt = logText()
    expect(count(txt, /^> 原始诉求$/gm)).toBe(1)  // 不是 2
    expect(count(txt, /^< 结论 A$/gm)).toBe(1)
    expect(count(txt, /^~ compact$/gm)).toBe(1)
  })

  it('/fork 全量重放不产生历史副本；分叉后的新活动写进带 parent 的新日志', async () => {
    const core = mkCore()
    say('结论 A')
    await core.send('老诉求')
    expect(logFiles().length).toBe(1)

    await core.send('/fork')
    expect(logFiles().length).toBe(1) // 重放被 suppress → fork 的 writer 一行都没写，不建文件

    say('结论 B')
    await core.send('分叉后的新诉求')
    core.dispose()

    const files = logFiles()
    expect(files.length).toBe(2)
    const forked = files.map(f => fs.readFileSync(f, 'utf8')).find(t => t.includes('parent:'))!
    expect(forked).toBeDefined()
    expect(forked).toContain('> 分叉后的新诉求')
    expect(forked).not.toContain('老诉求')   // 历史副本
    expect(forked).not.toContain('结论 A')
  })

  it('/background 全量重放不产生历史副本（后台会话的日志由子进程写）', async () => {
    const spawnFn = vi.fn(() => ({ unref: () => {}, pid: 4242 })) as any
    const core = mkCore({ spawnFn })
    say('结论 A')
    await core.send('老诉求')
    expect(logFiles().length).toBe(1)

    const r = await core.backgroundSession('接着干')
    core.dispose()

    expect(r.ok).toBe(true)
    expect(logFiles().length).toBe(1)                        // fork 出的后台会话未产生历史副本日志
    expect(count(logText(), /^> 老诉求$/gm)).toBe(1)
  })

  it('/loop 固定周期首轮：活动日志记用户真实任务，而非占位显示行（Minor 2）', async () => {
    const core = mkCore()
    say('已盯上')
    await core.send('/loop 5m 盯一下部署')
    core.dispose()

    const txt = logText()
    expect(txt).toContain('> 盯一下部署')      // 真实任务入日志
    expect(txt).not.toContain('（/loop 首轮）') // 占位显示行不入日志
  })

  it('resume 续写同一日志文件，不分片', async () => {
    const core = mkCore()
    say('结论 A')
    await core.send('第一轮')
    core.dispose()

    const core2 = mkCore({ continueSession: true })
    say('结论 B')
    await core2.send('第二轮')
    core2.dispose()

    expect(logFiles().length).toBe(1) // 同一会话，同一个日志文件
    const txt = logText()
    expect(txt).toContain('> 第一轮')
    expect(txt).toContain('> 第二轮')
    expect(count(txt, /^---$/gm)).toBe(2) // frontmatter 只有一份
  })
})
