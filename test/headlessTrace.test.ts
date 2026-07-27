import { describe, it, expect } from 'vitest'
import { headlessToolArg } from '../src/headlessTrace.js'

describe('headlessToolArg', () => {
  it('Read 显示完整 file_path + offset/limit', () => {
    const out = headlessToolArg('Read', JSON.stringify({ file_path: '/a/b/c.ts', offset: 100, limit: 50 }))
    expect(out).toBe('/a/b/c.ts [offset:100 limit:50]')
  })
  it('Read 无 offset/limit 只显示路径', () => {
    expect(headlessToolArg('Read', JSON.stringify({ file_path: '/a/b/c.ts' }))).toBe('/a/b/c.ts')
  })
  it('Edit 显示 file_path + 行数增减', () => {
    const out = headlessToolArg('Edit', JSON.stringify({ file_path: '/a.ts', old_string: 'x\ny\nz', new_string: 'x\ny' }))
    expect(out).toBe('/a.ts +2/-3 行')
  })
  it('Edit replace_all 标 (all)', () => {
    const out = headlessToolArg('Edit', JSON.stringify({ file_path: '/a.ts', old_string: 'x', new_string: 'y', replace_all: true }))
    expect(out).toBe('/a.ts +1/-1 行 (all)')
  })
  it('Write 显示 file_path + 行数，不含正文', () => {
    const out = headlessToolArg('Write', JSON.stringify({ file_path: '/a.ts', content: 'l1\nl2\nl3' }))
    expect(out).toBe('/a.ts 3 行')
    expect(out).not.toContain('l1')
  })
  it('Bash 完整命令，多行折叠', () => {
    expect(headlessToolArg('Bash', JSON.stringify({ command: 'echo a\necho b' }))).toBe('echo a echo b')
  })
  it('Grep 带 pattern + path + glob', () => {
    const out = headlessToolArg('Grep', JSON.stringify({ pattern: 'TODO', path: 'src', glob: '*.ts' }))
    expect(out).toBe('pattern=TODO path=src glob=*.ts')
  })
  it('Glob 带 pattern + path', () => {
    expect(headlessToolArg('Glob', JSON.stringify({ pattern: '**/*.ts', path: 'src' }))).toBe('**/*.ts path=src')
  })
  it('Agent 带 description + subagent_type', () => {
    const out = headlessToolArg('Agent', JSON.stringify({ description: '审代码', subagent_type: 'Explore' }))
    expect(out).toBe('审代码 [Explore]')
  })
  it('TaskCreate 走通用提取', () => {
    expect(headlessToolArg('TaskCreate', JSON.stringify({ subject: '修 bug' }))).toBe('修 bug')
  })
  it('超长字段 500 后加 …', () => {
    const out = headlessToolArg('Bash', JSON.stringify({ command: 'x'.repeat(600) }))
    expect(out.length).toBe(501)
    expect(out.endsWith('…')).toBe(true)
  })
  it('JSON 解析失败降级原文 500 清理', () => {
    expect(headlessToolArg('Read', '{坏')).toBe('{坏')
  })
})
