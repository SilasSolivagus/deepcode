import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import { buildSubagentPermission } from '../src/subagentRunner.js'
import type { PermissionSnapshot } from '../src/permissions.js'

describe('fenceRoot 兜底不得 fail-open', () => {
  it('父快照存在但 cwd 缺失 → 告警，且不静默回落到实时 cwd', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const parent = { mode: 'default', rules: [] } as PermissionSnapshot // 无 cwd
    const pc = buildSubagentPermission(parent, '/repo')
    expect(pc.cwd).toBe('/repo')
    expect(warn).toHaveBeenCalled() // 缺 cwd 是异常，必须可观测
    warn.mockRestore()
  })

  it('回归：父快照含 cwd → 不告警（正常路径不产生噪音）', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const parent: PermissionSnapshot = { mode: 'default', rules: [], cwd: '/repo' }
    const pc = buildSubagentPermission(parent, '/repo')
    expect(pc.cwd).toBe('/repo')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('三处注入点 cwd 同源', () => {
  // 配对括号计数取块，而非非贪婪正则：非贪婪正则在 useChat.ts 里会被 classify 回调参数中
  // 提前出现的 `})`（嵌套对象字面量）截断，误判块内不含 cwd（假红）。
  // 同时真正比对 parentPermission 块与 permission 块里的 cwd 表达式是否同一变量，
  // 而不只是断言"parentPermission 块内有 cwd 字样"——后者对"两处各自手填了不同变量"零判别力。
  function extractBlock(src: string, marker: string): string {
    const idx = src.indexOf(marker)
    if (idx < 0) return ''
    const start = src.indexOf('{', idx)
    let depth = 0
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) return src.slice(start, i + 1)
      }
    }
    return ''
  }
  function cwdExpr(block: string): string {
    const m = /\bcwd:\s*([^,\n]+)/.exec(block)
    return m ? m[1].trim() : ''
  }

  for (const f of ['src/tui/useChat.ts', 'src/headless.ts', 'src/backgroundRunner.ts']) {
    it(`${f} 的 parentPermission().cwd 与 permission.cwd 同源`, () => {
      const src = fs.readFileSync(f, 'utf8')
      const parentBlock = extractBlock(src, 'parentPermission: () => (')
      const permBlock = extractBlock(src, 'permission: {')
      expect(parentBlock).toMatch(/\bcwd:/)
      expect(permBlock).toMatch(/\bcwd:/)
      const parentCwd = cwdExpr(parentBlock)
      expect(parentCwd).not.toBe('')
      expect(parentCwd).toBe(cwdExpr(permBlock))
    })
  }
})
