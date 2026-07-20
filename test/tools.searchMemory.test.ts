import { describe, it, expect } from 'vitest'
import { formatSearchResults, searchMemoryTool } from '../src/tools/searchMemory.js'
import { allTools } from '../src/tools/index.js'

describe('SearchMemory 工具', () => {
  it('formatSearchResults 无命中给出提示', () => {
    expect(formatSearchResults([])).toContain('没有找到')
  })
  it('formatSearchResults 列出键/scope/片段', () => {
    const out = formatSearchResults([
      { key: 'project:a.md', scope: 'project', description: 'a', snippet: '不喜欢 tailwind', score: -1 },
    ])
    expect(out).toContain('project:a.md')
    expect(out).toContain('不喜欢 tailwind')
  })
  it('工具元信息：只读、无需权限、在 allTools 内', () => {
    expect(searchMemoryTool.name).toBe('SearchMemory')
    expect(searchMemoryTool.isReadOnly).toBe(true)
    expect(searchMemoryTool.needsPermission({ query: 'x' } as any)).toBe(false)
    expect(allTools.some(t => t.name === 'SearchMemory')).toBe(true)
  })
})
