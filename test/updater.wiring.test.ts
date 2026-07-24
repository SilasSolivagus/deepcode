import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChatCore, displayTextOf } from '../src/tui/useChat.js'
import { BUILTIN_COMMANDS } from '../src/tui/suggest.js'

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dc-wire-'))

// transcript 是多种 kind 的联合（user/assistant/notice/tool/...），displayTextOf 只认 assistant/reasoning
// 的 segments 形状；/update /doctor 走 notice()，是 { kind: 'notice'; text } 形状。按 kind 取文本，
// 而不是对整个 transcript 盲目 map(displayTextOf)（那样对非 assistant/reasoning 项会因 segments 是
// undefined 而抛错）。
const textOf = (it: any): string => ('segments' in it ? displayTextOf(it) : (it.text ?? ''))

describe('升级子系统 TUI 接线（行为）', () => {
  it('ChatState 初始 updateStatus 为 null', () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir: tmpDir(), onState: () => {} })
    expect(core.state.updateStatus).toBeNull()
  })

  it('/update 在 DEEPCODE_DISABLE_UPDATES=1 下给出明确拒绝', async () => {
    const prev = process.env.DEEPCODE_DISABLE_UPDATES
    process.env.DEEPCODE_DISABLE_UPDATES = '1'
    try {
      const states: any[] = []
      const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir: tmpDir(), onState: s => states.push(s) })
      await core.send('/update')
      const texts = states.at(-1)!.transcript.map(textOf).join('\n')
      expect(texts).toContain('DEEPCODE_DISABLE_UPDATES')
    } finally {
      if (prev === undefined) delete process.env.DEEPCODE_DISABLE_UPDATES
      else process.env.DEEPCODE_DISABLE_UPDATES = prev
    }
  })

  it('/doctor 输出含版本项', async () => {
    const states: any[] = []
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir: tmpDir(), onState: s => states.push(s) })
    await core.send('/doctor')
    const texts = states.at(-1)!.transcript.map(textOf).join('\n')
    expect(texts).toContain('版本')
  })

  it('/update 进命令菜单', () => {
    expect(BUILTIN_COMMANDS.map(c => c.value)).toContain('/update')
  })
})

describe('双组件对称接线护栏', () => {
  // 有意的源码文本断言：默认渲染器是 FullscreenApp，只改 App.tsx 会让功能整个不生效，
  // 而这一层从渲染侧无法廉价观测（updateStatus 是 core 内部异步状态）。历史上此坑复发过多次。
  it('App 与 FullscreenApp 都把 updateStatus 传给 StatusFooter', () => {
    const appSrc = fs.readFileSync(path.join(process.cwd(), 'src/tui/App.tsx'), 'utf8')
    const fullSrc = fs.readFileSync(path.join(process.cwd(), 'src/tui/FullscreenApp.tsx'), 'utf8')
    expect(appSrc).toContain('updateStatus={state.updateStatus}')
    expect(fullSrc).toContain('updateStatus={state.updateStatus}')
  })
})
