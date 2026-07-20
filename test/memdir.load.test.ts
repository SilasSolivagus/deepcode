import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { truncateEntrypoint, loadMemoryPrompt, loadGlobalMemoryPrompt, MAX_ENTRYPOINT_LINES } from '../src/memdir/memdir.js'

test('truncateEntrypoint 行数上限', () => {
  const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
  const out = truncateEntrypoint(many)
  expect(out.split('\n').length).toBeLessThanOrEqual(MAX_ENTRYPOINT_LINES + 1)
  expect(out).toContain('截断')
})

test('truncateEntrypoint 字节上限（含省略提示也不超）', () => {
  const big = 'x'.repeat(30000)
  const out = truncateEntrypoint(big)
  expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(25600)
  expect(out).toContain('截断')
})

test('truncateEntrypoint 多字节不裂字符且不超字节上限', () => {
  const big = '汉'.repeat(20000) // 每字 3 字节 = 60000 字节
  const out = truncateEntrypoint(big)
  expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(25600)
  expect(out.includes('�')).toBe(false) // 无替换字符
})

describe('loadMemoryPrompt', () => {
  let md: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-load-')) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }) })
  test('有 MEMORY.md → 注入内容 + 查阅指令', () => {
    fs.writeFileSync(path.join(md, 'MEMORY.md'), '- [a](a.md) — hook')
    const out = loadMemoryPrompt(md)
    expect(out).toContain('## 记忆索引')
    expect(out).toContain('a.md')
    expect(out).toContain('先扫这份索引') // 查阅指令：治「不会自动想起」
    expect(out).toContain('Read')
  })
  test('无 MEMORY.md → 空提示，不含查阅指令（无可查）', () => {
    const out = loadMemoryPrompt(md)
    expect(out).toContain('## 记忆索引')
    expect(out).toContain('暂无')
    expect(out).not.toContain('先扫这份索引')
  })
})

describe('loadGlobalMemoryPrompt', () => {
  let g: string
  beforeEach(() => { g = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-gl-')) })
  afterEach(() => { fs.rmSync(g, { recursive: true, force: true }) })

  test('空目录返回空串（不注入空段）', () => {
    expect(loadGlobalMemoryPrompt(g, 8192)).toBe('')
  })
  test('目录不存在返回空串', () => {
    expect(loadGlobalMemoryPrompt(path.join(g, 'nope'), 8192)).toBe('')
  })
  test('预算内：注入正文全文，剥掉 frontmatter', () => {
    fs.writeFileSync(path.join(g, 'a.md'), '---\nname: a\ntype: user\n---\n写前端时避开 tailwind。')
    const out = loadGlobalMemoryPrompt(g, 8192)
    expect(out).toContain('写前端时避开 tailwind。')
    expect(out).not.toContain('type: user')  // frontmatter 不进系统提示
    expect(out).toContain('你的长期偏好')
  })
  test('含反邀功指令（铁律一：取不邀功）', () => {
    fs.writeFileSync(path.join(g, 'a.md'), '正文')
    const out = loadGlobalMemoryPrompt(g, 8192)
    expect(out).toContain('不要在回复里提起')
    expect(out).toContain('我记得你说过')
  })
  test('超预算：降级为索引清单，不再全文', () => {
    fs.writeFileSync(path.join(g, 'big.md'), 'x'.repeat(500))
    fs.writeFileSync(path.join(g, 'big2.md'), 'y'.repeat(500))
    const out = loadGlobalMemoryPrompt(g, 100)
    expect(out).not.toContain('x'.repeat(500))
    expect(out).toContain('big.md')
    expect(out).toContain('MemRead')
  })
  test('跳过 MEMORY.md 与保留文件', () => {
    fs.writeFileSync(path.join(g, 'MEMORY.md'), '索引')
    fs.writeFileSync(path.join(g, '.write-lock'), '123')
    fs.writeFileSync(path.join(g, 'a.md'), '正文')
    const out = loadGlobalMemoryPrompt(g, 8192)
    expect(out).not.toContain('索引')
    expect(out).toContain('正文')
  })
  test('子目录里的全局记忆也被递归扫到并全文注入（回归：曾经非递归 readdir 会漏掉）', () => {
    fs.mkdirSync(path.join(g, 'preferences'), { recursive: true })
    fs.writeFileSync(path.join(g, 'preferences', 'tailwind.md'), '---\ntype: user\n---\n写前端时避开 tailwind。')
    const out = loadGlobalMemoryPrompt(g, 8192)
    expect(out).toContain('写前端时避开 tailwind。')
  })
  test('降级索引模式下子目录文件带相对路径列出，方便 MemRead 定位', () => {
    fs.mkdirSync(path.join(g, 'preferences'), { recursive: true })
    fs.writeFileSync(path.join(g, 'preferences', 'tailwind.md'), 'x'.repeat(500))
    fs.writeFileSync(path.join(g, 'big2.md'), 'y'.repeat(500))
    const out = loadGlobalMemoryPrompt(g, 100)
    expect(out).toContain('preferences/tailwind.md')
    expect(out).toContain('big2.md')
  })
  test('顶层文件的全文注入行为不受递归改动影响（回归）', () => {
    fs.writeFileSync(path.join(g, 'a.md'), '---\ntype: user\n---\n顶层记忆正文。')
    const out = loadGlobalMemoryPrompt(g, 8192)
    expect(out).toContain('顶层记忆正文。')
    expect(out).toContain('你的长期偏好')
  })
})
