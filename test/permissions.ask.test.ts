// test/permissions.ask.test.ts
import { describe, it, expect } from 'vitest'
import { checkPermission, type PermissionContext } from '../src/permissions.js'
import { bashTool } from '../src/tools/bash.js'
import { readTool } from '../src/tools/read.js'
import { editTool } from '../src/tools/edit.js'

const pc = (over: Partial<PermissionContext> = {}): PermissionContext => ({
  mode: 'default', rules: [], saveRule: () => {}, ask: async () => 'no', cwd: '/proj', ...over,
})

describe('ask 桶·命令/描述维度', () => {
  it('Bash(rm:*) ask 规则在 yolo 下仍强制弹窗（ask>yolo）', async () => {
    let asked = false
    const r = await checkPermission(bashTool, { command: 'rm foo.txt' },
      pc({ mode: 'yolo', askRules: ['Bash(rm:*)'], ask: async () => { asked = true; return 'no' } }))
    expect(asked).toBe(true); expect(r.ok).toBe(false)
  })
  it('Edit ask 规则 + 同项 allow 规则并存 → 仍弹（ask>allow）', async () => {
    let asked = false
    const r = await checkPermission(editTool, { file_path: '/proj/a.ts', old_string: 'x', new_string: 'y' },
      pc({ rules: ['Edit(编辑 /proj/a.ts)'], askRules: ['Edit(编辑 /proj/a.ts)'],
           ask: async () => { asked = true; return 'yes' } }))
    expect(asked).toBe(true); expect(r.ok).toBe(true)
  })
  it('ask 命中归因 behavior:ask + source', async () => {
    const r = await checkPermission(bashTool, { command: 'rm foo' },
      pc({ askRules: ['Bash(rm:*)'], askSources: { 'Bash(rm:*)': 'project' }, ask: async () => 'yes' }))
    expect(r.ok).toBe(true)
    expect(r.decisionReason).toEqual({ type: 'rule', rule: { source: 'project', behavior: 'ask', value: 'Bash(rm:*)' } })
  })
})

describe('ask 桶·路径维度（裸 glob，含只读）', () => {
  it('**/.env ask → 只读 Read .env 强制弹窗', async () => {
    let asked = false
    const r = await checkPermission(readTool, { file_path: '/proj/.env' },
      pc({ askRules: ['**/.env'], ask: async () => { asked = true; return 'no' } }))
    expect(asked).toBe(true); expect(r.ok).toBe(false)
  })
  it('**/.env ask → Edit .env 强制弹窗（凌驾 allow）', async () => {
    let asked = false
    const r = await checkPermission(editTool, { file_path: '/proj/.env', old_string: 'a', new_string: 'b' },
      pc({ rules: ['Edit(编辑 /proj/.env)'], askRules: ['**/.env'], ask: async () => { asked = true; return 'yes' } }))
    expect(asked).toBe(true); expect(r.ok).toBe(true)
  })
  it('裸 glob 不误伤无关只读读取', async () => {
    let asked = false
    const r = await checkPermission(readTool, { file_path: '/proj/src/a.ts' },
      pc({ askRules: ['**/.env'], ask: async () => { asked = true; return 'no' } }))
    expect(asked).toBe(false); expect(r.ok).toBe(true)
  })
})
