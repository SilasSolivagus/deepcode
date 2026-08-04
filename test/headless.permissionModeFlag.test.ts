// test/headless.permissionModeFlag.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parsePermissionMode, PERMISSION_MODES } from '../src/permissions.js'

const script: Array<{ result?: any }> = []
vi.mock('../src/api.js', () => ({
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      return scene.result
    })(),
  ),
}))

const mockSettings: any = {
  permissions: { allow: [] },
  compactTokens: 200_000,
  hooks: { SessionStart: [{ matcher: '*', hooks: [] }], InstructionsLoaded: [{ matcher: '*', hooks: [] }], UserPromptSubmit: [{ matcher: '*', hooks: [] }] },
}
vi.mock('../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../src/config.js')>()
  return { ...actual, loadSettings: vi.fn(() => mockSettings) }
})
vi.mock('../src/settingsLayers.js', async (orig) => {
  const actual = await orig<typeof import('../src/settingsLayers.js')>()
  return {
    ...actual,
    loadLayeredSettings: vi.fn(() => ({
      settings: mockSettings, provenance: {},
      permissionSources: { allow: {}, deny: {} }, scopes: [], strippedDangerousRules: [],
    })),
  }
})

import { runHeadless } from '../src/headless.js'
import { createChatCore } from '../src/tui/useChat.js'

const usage = { prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 0 }
/** 一轮：模型要写文件（需要权限）→ 下一轮收工。权限模式的差异全体现在第一轮能不能写成。 */
const wantsWrite = (file: string) => ({
  result: {
    content: '', usage, finishReason: 'tool_calls',
    toolCalls: [{ id: 'w1', name: 'Write', args: JSON.stringify({ file_path: file, content: 'x' }) }],
  },
})
const finish = { result: { content: '收工', toolCalls: [], usage, finishReason: 'stop' } }

beforeEach(() => { script.length = 0 })

describe('parsePermissionMode', () => {
  it('未传时返回 undefined', () => {
    expect(parsePermissionMode(['-p', '任务'])).toBeUndefined()
  })
  it('六个合法取值原样返回', () => {
    for (const m of PERMISSION_MODES) expect(parsePermissionMode(['--permission-mode', m])).toBe(m)
  })
  it('非法取值当场报错，不再静默退化成 default', () => {
    // 回归：此前是 `(opts.permMode as any) || 'default'`，拼错一个字母会让 checkPermission 里
    // 所有 mode === '…' 分支全不命中，行为静默变成 default。
    for (const bad of ['yolow', 'YOLO', 'accept-edits', 'ask']) {
      expect(() => parsePermissionMode(['--permission-mode', bad]), `值=${bad}`).toThrow(/--permission-mode/)
    }
  })
  it('缺少取值 / 取值是另一个 flag 时报错，且与「非法取值」是两条不同的消息', () => {
    // 变异测试抓到的弱点：两条路径的报错都含 "--permission-mode"，只匹配这个词分不出来——
    // 去掉取值校验后 undefined 会掉进白名单分支照样抛，断言仍通过。故必须断到具体措辞。
    expect(() => parsePermissionMode(['--permission-mode'])).toThrow(/需要一个取值/)
    expect(() => parsePermissionMode(['--permission-mode', '--yolo'])).toThrow(/需要一个取值/)
    expect(() => parsePermissionMode(['--permission-mode', 'yolow'])).toThrow(/只支持/)
  })
})

describe('runHeadless 认 --permission-mode', () => {
  it('acceptEdits：Write 被放行（default 下会被拒）', async () => {
    const f = path.join(process.cwd(), '.tmp-permmode-accept.txt')
    fs.rmSync(f, { force: true })
    script.push(wantsWrite(f), finish)
    await runHeadless({ client: {} as any, prompt: '写个文件', yolo: false, permissionMode: 'acceptEdits' })
    expect(fs.existsSync(f), 'acceptEdits 下 Write 应当落盘').toBe(true)
    fs.rmSync(f, { force: true })
  })

  it('default：同一个 Write 被拒（证明上一条不是「反正都能写」）', async () => {
    const f = path.join(process.cwd(), '.tmp-permmode-default.txt')
    fs.rmSync(f, { force: true })
    script.push(wantsWrite(f), finish)
    await runHeadless({ client: {} as any, prompt: '写个文件', yolo: false })
    expect(fs.existsSync(f), 'default 下 askUp 恒 no，Write 不该落盘').toBe(false)
  })

  it('plan：非只读工具一律拒', async () => {
    const f = path.join(process.cwd(), '.tmp-permmode-plan.txt')
    fs.rmSync(f, { force: true })
    script.push(wantsWrite(f), finish)
    await runHeadless({ client: {} as any, prompt: '写个文件', yolo: false, permissionMode: 'plan' })
    expect(fs.existsSync(f)).toBe(false)
  })

  it('--yolo 仍然压过一切（未传 permissionMode 时行为不变）', async () => {
    const f = path.join(process.cwd(), '.tmp-permmode-yolo.txt')
    fs.rmSync(f, { force: true })
    script.push(wantsWrite(f), finish)
    await runHeadless({ client: {} as any, prompt: '写个文件', yolo: true })
    expect(fs.existsSync(f)).toBe(true)
    fs.rmSync(f, { force: true })
  })
})

describe('auto 模式必须带分类器', () => {
  // checkPermission 的 auto 分支要求 pc.classify 为真，否则整段被跳过、静默退化成 default。
  // 此前 headless 与 backgroundRunner 都没提供它——而 /background 会把 TUI 当前模式传进来，
  // 于是「在 auto 模式下开的后台任务」实际跑在 default 下，需要权限的工具全被拒且无提示。
  it('headless 与 backgroundRunner 都把 classify 接进两处权限上下文', () => {
    for (const f of ['src/headless.ts', 'src/backgroundRunner.ts']) {
      const src = fs.readFileSync(path.join(process.cwd(), f), 'utf8')
      const hits = src.match(/classify: \(t: string, d: string, sib: string\)/g) ?? []
      // 两处：ctx.parentPermission（工具侧）与 loop 的 permission（主循环侧），漏一处就半瘸。
      expect(hits.length, `${f} 只接了 ${hits.length} 处 classify，应为 2 处`).toBe(2)
    }
  })
})

describe('createChatCore 真的用了传进来的 permissionMode', () => {
  // 变异测试抓到的弱点：此前 TUI 侧只有源码文本断言，只验「线接上了」，没验「接到的东西被用了」。
  // 把 prop 一路传到 useChat 然后忽略掉，那些断言照样全绿——正是 --model 那个 bug 往下一层的同构形态。
  const mk = (extra: any) => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'permmode-'))
    return createChatCore({ client: {} as any, cwd: dir, sessionDir: dir, home: dir, onState: () => {}, yolo: false, ...extra })
  }
  it('传了 permissionMode 就用它', () => {
    expect(mk({ permissionMode: 'plan' }).permMode()).toBe('plan')
    expect(mk({ permissionMode: 'acceptEdits' }).permMode()).toBe('acceptEdits')
  })
  it('没传时仍是 default，行为不变', () => {
    expect(mk({}).permMode()).toBe('default')
  })
  it('--yolo 压过 permissionMode（冲突在 index.ts 已报错，这里只锁核心层次序）', () => {
    expect(mk({ yolo: true, permissionMode: 'plan' }).permMode()).toBe('yolo')
  })
})

describe('双组件对称接线护栏：--permission-mode', () => {
  it('App 与 FullscreenApp 都声明 permissionMode 并交给 createChatCore', () => {
    for (const f of ['src/tui/App.tsx', 'src/tui/FullscreenApp.tsx']) {
      const src = fs.readFileSync(path.join(process.cwd(), f), 'utf8')
      expect(src, `${f} 缺 permissionMode props 声明`).toContain('permissionMode?:')
      expect(src, `${f} 没把 permissionMode 传给 createChatCore`).toContain('permissionMode: props.permissionMode')
    }
  })
  it('startTui 把 permissionMode 交给渲染的那个组件', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/tui/index.tsx'), 'utf8')
    expect(src).toContain('permissionMode={opts.permissionMode}')
  })
})
