// test/permissionsView.ask.test.ts
import { describe, it, expect } from 'vitest'
import { formatPermissionRules } from '../src/permissionsView.js'

describe('formatPermissionRules 含 Ask 段', () => {
  it('渲染 ask 段带来源', () => {
    const out = formatPermissionRules(
      ['Bash(ls)'], { 'Bash(ls)': 'user' },
      [], {},
      ['Bash(rm:*)', '**/.env'], { 'Bash(rm:*)': 'user', '**/.env': 'project' },
    )
    expect(out).toContain('强制询问规则（Ask）')
    expect(out).toContain('1. Bash(rm:*)')
    expect(out).toContain('2. **/.env')
    expect(out).toContain('ask-rm')
  })
  it('三桶皆空提示无规则', () => {
    expect(formatPermissionRules([], {}, [], {}, [], {})).toBe('没有已保存的权限规则')
  })
})
