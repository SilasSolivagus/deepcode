import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { searchMemories } from '../src/memdir/memSearch.js'

let proj: string
const write = (dir: string, name: string, desc: string, body: string) =>
  fs.writeFileSync(path.join(dir, name), `---\ndescription: ${desc}\ntype: user\n---\n${body}\n`)

beforeEach(() => { proj = fs.mkdtempSync(path.join(os.tmpdir(), 'memsearch-')) })
afterEach(() => { fs.rmSync(proj, { recursive: true, force: true }) })

describe('searchMemories', () => {
  it('按正文关键词命中并按 bm25 排序，scope 标注正确', async () => {
    write(proj, 'a.md', 'a', '用户明确说不喜欢 tailwind，用原生 css')
    write(proj, 'b.md', 'b', '项目用 vitest 跑测试')
    const hits = await searchMemories({ project: proj }, 'tailwind css')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].key).toBe('project:a.md')
    expect(hits[0].scope).toBe('project')
    expect(hits[0].snippet).toContain('tailwind')
  })

  it('空/纯空白查询返回空', async () => {
    write(proj, 'a.md', 'a', 'something')
    expect(await searchMemories({ project: proj }, '   ')).toEqual([])
  })

  it('无记忆返回空', async () => {
    expect(await searchMemories({ project: proj }, 'tailwind')).toEqual([])
  })

  it('查询含 FTS5 特殊字符不抛错', async () => {
    write(proj, 'a.md', 'a', 'tailwind here')
    const hits = await searchMemories({ project: proj }, 'tail"wind AND (css')
    expect(Array.isArray(hits)).toBe(true)
  })

  it('尊重 limit', async () => {
    for (let i = 0; i < 5; i++) write(proj, `m${i}.md`, `m${i}`, 'css css css')
    const hits = await searchMemories({ project: proj }, 'css', 2)
    expect(hits.length).toBe(2)
  })

  it('新增文件后缓存失效、能搜到新文件', async () => {
    write(proj, 'a.md', 'a', 'alpha term')
    await searchMemories({ project: proj }, 'alpha')
    write(proj, 'b.md', 'b', 'beta term')
    const hits = await searchMemories({ project: proj }, 'beta')
    expect(hits.some(h => h.key === 'project:b.md')).toBe(true)
  })

  it('两个不同项目目录同名文件不串缓存', async () => {
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'memsearch-a-'))
    const projB = fs.mkdtempSync(path.join(os.tmpdir(), 'memsearch-b-'))
    try {
      write(projA, 'a.md', 'a', '只在 A 出现的 quixterma 内容')
      write(projB, 'a.md', 'a', '只在 B 出现的 quixtermb 内容')
      // 强制两个 a.md 的 mtimeMs 完全相同，使 dirs 成为唯一能区分两次调用的变量
      // （文件系统亚毫秒精度下自然写入的 mtimeMs 通常已经不同，
      // 若签名不含 dirs，内容差异会让旧签名也失效，测试就无法证伪 bug）。
      const t = new Date(1700000000000)
      fs.utimesSync(path.join(projA, 'a.md'), t, t)
      fs.utimesSync(path.join(projB, 'a.md'), t, t)

      const hitsA = await searchMemories({ project: projA }, 'quixterma')
      expect(hitsA.length).toBe(1)
      expect(hitsA[0].snippet).toContain('quixterma')

      const hitsB = await searchMemories({ project: projB }, 'quixtermb')
      expect(hitsB.length).toBe(1)
      expect(hitsB[0].snippet).toContain('quixtermb')
      expect(hitsB[0].snippet).not.toContain('quixterma')
    } finally {
      fs.rmSync(projA, { recursive: true, force: true })
      fs.rmSync(projB, { recursive: true, force: true })
    }
  })
})
