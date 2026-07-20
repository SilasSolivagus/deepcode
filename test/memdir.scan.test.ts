import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanMemoryFiles, scanAllMemories, formatMemoryManifest, memoryKey, MAX_MEMORY_FILES } from '../src/memdir/memoryScan.js'

function write(dir: string, name: string, body: string) {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
  fs.writeFileSync(path.join(dir, name), body)
}

describe('scanMemoryFiles', () => {
  let md: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-scan-')) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }) })

  test('解析 frontmatter、排除 MEMORY.md、按 mtime 降序', async () => {
    write(md, 'a.md', '---\nname: a\ndescription: desc A\ntype: user\n---\nbody')
    write(md, 'MEMORY.md', '- [a](a.md) — x')
    write(md, 'sub/b.md', '---\nname: b\ndescription: desc B\ntype: project\n---\nbody')
    // 让 b 比 a 新
    const now = Date.now()
    fs.utimesSync(path.join(md, 'a.md'), new Date(now - 10000), new Date(now - 10000))
    fs.utimesSync(path.join(md, 'sub/b.md'), new Date(now), new Date(now))
    const heads = await scanMemoryFiles(md)
    expect(heads.map(h => h.filename)).toEqual([path.join('sub', 'b.md'), 'a.md'])
    expect(heads[0]).toMatchObject({ description: 'desc B', type: 'project' })
    expect(heads.find(h => h.filename === 'MEMORY.md')).toBeUndefined()
  })

  test('坏 frontmatter → description null / type undefined，不抛', async () => {
    write(md, 'bad.md', 'no frontmatter here')
    const heads = await scanMemoryFiles(md)
    expect(heads[0]).toMatchObject({ description: null, type: undefined })
  })

  test('目录不存在 → 空数组', async () => {
    expect(await scanMemoryFiles(path.join(md, 'nope'))).toEqual([])
  })
})

test('formatMemoryManifest 列出每条', () => {
  const out = formatMemoryManifest([
    { filename: 'a.md', filePath: '/x/a.md', scope: 'project', mtimeMs: 0, description: 'd', type: 'user' },
  ])
  expect(out).toContain('a.md')
  expect(out).toContain('d')
  expect(out).toContain('user')
})

describe('双抽屉扫描', () => {
  let proj: string, glob: string
  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-scan2-'))
    proj = path.join(tmp, 'p'); glob = path.join(tmp, 'g')
    fs.mkdirSync(proj, { recursive: true }); fs.mkdirSync(glob, { recursive: true })
  })

  test('scope 由所在 root 派生，不读 frontmatter', async () => {
    // 文件里谎称 scope: global，但它在项目目录里 → 必须是 project
    fs.writeFileSync(path.join(proj, 'a.md'), '---\ndescription: d\ntype: user\nscope: global\n---\n')
    const heads = await scanMemoryFiles(proj, 'project')
    expect(heads[0].scope).toBe('project')
  })

  test('scanAllMemories 合并两根，各带正确 scope', async () => {
    fs.writeFileSync(path.join(proj, 'a.md'), '---\ndescription: 项目的\ntype: project\n---\n')
    fs.writeFileSync(path.join(glob, 'b.md'), '---\ndescription: 全局的\ntype: user\n---\n')
    const heads = await scanAllMemories(proj, glob)
    expect(heads.map(h => memoryKey(h)).sort()).toEqual(['global:b.md', 'project:a.md'])
  })

  test('同名文件不碰撞（两个抽屉都有 tailwind.md）', async () => {
    fs.writeFileSync(path.join(proj, 'tailwind.md'), '---\ndescription: 项目版\n---\n')
    fs.writeFileSync(path.join(glob, 'tailwind.md'), '---\ndescription: 全局版\n---\n')
    const heads = await scanAllMemories(proj, glob)
    expect(heads.length).toBe(2)
    const keys = heads.map(memoryKey)
    expect(new Set(keys).size).toBe(2) // 身份键不重复
    const paths = heads.map(h => h.filePath)
    expect(new Set(paths).size).toBe(2)
  })

  test('两根各自独立 200 配额：项目写爆不挤掉全局条目', async () => {
    for (let i = 0; i < MAX_MEMORY_FILES + 10; i++) {
      fs.writeFileSync(path.join(proj, `p${i}.md`), '---\ndescription: 噪声\n---\n')
    }
    fs.writeFileSync(path.join(glob, 'keep.md'), '---\ndescription: 珍贵的全局偏好\n---\n')
    const heads = await scanAllMemories(proj, glob)
    expect(heads.some(h => memoryKey(h) === 'global:keep.md')).toBe(true)
    expect(heads.filter(h => h.scope === 'project').length).toBe(MAX_MEMORY_FILES)
  })

  test('无全局抽屉时退化为单根', async () => {
    fs.writeFileSync(path.join(proj, 'a.md'), '---\ndescription: d\n---\n')
    const heads = await scanAllMemories(proj, undefined)
    expect(heads.length).toBe(1)
    expect(heads[0].scope).toBe('project')
  })

  test('manifest 带身份键', async () => {
    fs.writeFileSync(path.join(glob, 'b.md'), '---\ndescription: 不喜欢 tailwind\ntype: user\n---\n')
    const heads = await scanAllMemories(proj, glob)
    expect(formatMemoryManifest(heads)).toBe('- global:b.md [user]: 不喜欢 tailwind')
  })
})
