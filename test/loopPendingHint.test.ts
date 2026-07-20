import { describe, it, expect } from 'vitest'
import { unknownToolMessage } from '../src/loop.js'

describe('unknownToolMessage', () => {
  it('未知 MCP 工具且其 server 仍 pending → 提示调 WaitForMcpServers', () => {
    const msg = unknownToolMessage('mcp__slow__do', ['Read', 'Bash'], ['slow'])
    expect(msg).toMatch(/WaitForMcpServers/)
    expect(msg).toMatch(/slow/)
  })
  it('未知普通工具 → 原「不存在」文案 + 可用工具列表', () => {
    const msg = unknownToolMessage('Frobnicate', ['Read', 'Bash'], [])
    expect(msg).toMatch(/不存在/)
    expect(msg).toMatch(/Read, Bash/)
  })
  it('未知 MCP 工具但 server 不在 pending → 原「不存在」文案', () => {
    const msg = unknownToolMessage('mcp__gone__do', ['Read'], ['other'])
    expect(msg).toMatch(/不存在/)
  })
})
