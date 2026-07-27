import { describe, it, expect } from 'vitest'
import { extractToolArg, clean, formatToolArg } from '../src/tui/toolArg.js'

describe('extractToolArg（无截断提取）', () => {
  it('Read/Edit/Write 取 file_path', () => {
    const long = '/Users/x/very/long/nested/path/to/some/deeply/buried/module/name.ts'
    expect(extractToolArg('Read', JSON.stringify({ file_path: long, offset: 100 }))).toBe(long)
    expect(extractToolArg('Edit', JSON.stringify({ file_path: long }))).toBe(long)
  })
  it('Bash 取 command，不截断', () => {
    const cmd = 'find . -name "*.ts" | xargs grep -l TODO | sort | head -50'
    expect(extractToolArg('Bash', JSON.stringify({ command: cmd }))).toBe(cmd)
  })
  it('Grep/Glob 取 pattern', () => {
    expect(extractToolArg('Grep', JSON.stringify({ pattern: 'TODO|FIXME', path: 'src' }))).toBe('TODO|FIXME')
  })
  it('TaskUpdate 组装 #id → status', () => {
    expect(extractToolArg('TaskUpdate', JSON.stringify({ taskId: '7', status: 'done' }))).toBe('#7 → done')
  })
  it('未知工具取第一个字符串字段', () => {
    expect(extractToolArg('Whatever', JSON.stringify({ n: 1, s: 'hi' }))).toBe('hi')
  })
  it('JSON 解析失败返回原串', () => {
    expect(extractToolArg('Read', '{坏')).toBe('{坏')
  })
})

describe('clean（可传上限）', () => {
  it('默认 60，折叠控制字符', () => {
    expect(clean('a\nb\tc')).toBe('a b c')
    expect(clean('x'.repeat(70)).endsWith('…')).toBe(true)
    expect(clean('x'.repeat(70)).length).toBe(61)
  })
  it('传 500 上限', () => {
    expect(clean('x'.repeat(600), 500).length).toBe(501)
    expect(clean('x'.repeat(400), 500)).toBe('x'.repeat(400))
  })
})

describe('formatToolArg（TUI 行为不变）', () => {
  it('仍截到 60', () => {
    const long = 'a'.repeat(100)
    expect(formatToolArg('Bash', JSON.stringify({ command: long })).length).toBe(61)
  })
})
