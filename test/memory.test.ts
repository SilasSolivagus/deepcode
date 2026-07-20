import { describe, it, expect, test } from 'vitest'
import path from 'node:path'
import { formatMemory, formatMemoryView } from '../src/memory.js'

const HOME = '/home/u'
const GLOBAL = path.join(HOME, '.deepcode', 'DEEPCODE.md')

describe('formatMemory', () => {
  it('空列表：提示没有生效的记忆文件 + 如何创建', () => {
    const out = formatMemory([], HOME)
    expect(out).toContain('当前没有生效的记忆文件')
    expect(out).toContain('/init')
    expect(out).toContain(GLOBAL)
  })

  it('单文件：列出该路径', () => {
    const f = '/work/proj/DEEPCODE.md'
    const out = formatMemory([f], HOME)
    expect(out).toContain(f)
    expect(out).not.toContain('当前没有生效的记忆文件')
  })

  it('多文件：项目 + 全局都列出', () => {
    const proj = '/work/proj/DEEPCODE.md'
    const out = formatMemory([proj, GLOBAL], HOME)
    expect(out).toContain(proj)
    expect(out).toContain(GLOBAL)
  })

  it('全局不在列表时：提示全局文件不存在、可创建', () => {
    const proj = '/work/proj/DEEPCODE.md'
    const out = formatMemory([proj], HOME)
    expect(out).toContain(GLOBAL)
    expect(out).toMatch(/不存在|可创建/)
  })

  it('全局已在列表时：不重复提示其不存在', () => {
    const out = formatMemory([GLOBAL], HOME)
    // 全局已生效，不应出现"不存在"这类提示
    expect(out).not.toMatch(/全局.*不存在/)
  })

  it('始终包含 /init 编辑提示', () => {
    expect(formatMemory(['/a/DEEPCODE.md'], HOME)).toContain('/init')
  })
})

describe('formatMemoryView', () => {
  const g = [{ index: 1, filename: 'tw.md', filePath: '/h/.deepcode/memory/tw.md', type: 'user', description: '不喜欢 tailwind', origin: '-repo-a', created: '2026-07-14' }]

  test('分两段：指令文件 + 全局记忆抽屉', () => {
    const out = formatMemoryView(['/proj/CLAUDE.md'], g, '/h')
    expect(out).toContain('指令文件')
    expect(out).toContain('全局记忆抽屉')
    expect(out).toContain('/proj/CLAUDE.md')
  })
  test('全局条目带编号、类型、来源、日期（可溯源）', () => {
    const out = formatMemoryView([], g, '/h')
    expect(out).toContain('[1]')
    expect(out).toContain('不喜欢 tailwind')
    expect(out).toContain('-repo-a')
    expect(out).toContain('2026-07-14')
  })
  test('提示删除用法', () => {
    expect(formatMemoryView([], g, '/h')).toContain('/memory rm')
  })
  test('全局抽屉为空时说明', () => {
    expect(formatMemoryView([], [], '/h')).toContain('暂无跨项目记忆')
  })
})
