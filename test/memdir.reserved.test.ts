import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isReservedPath, assertNotReserved, RESERVED_SUBTREES } from '../src/memdir/reserved.js'
import { scanMemoryFiles } from '../src/memdir/memoryScan.js'
import { makeMemdirTools } from '../src/services/memory/memdirTools.js'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memdir-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('isReservedPath', () => {
  it('保留子树下的路径为真', () => {
    for (const s of RESERVED_SUBTREES) expect(isReservedPath(`${s}/2026/07/13/x.md`)).toBe(true)
  })
  it('顶层记忆文件为假', () => {
    expect(isReservedPath('foo.md')).toBe(false)
    expect(isReservedPath('MEMORY.md')).toBe(false)
  })
  it('名字仅以保留词开头的目录不算保留（logsfoo/）', () => {
    expect(isReservedPath('logsfoo/x.md')).toBe(false)
  })
  it('.write-lock 作为目录名（多段路径）时也算保留，不只是精确单段文件名（M4）', () => {
    expect(isReservedPath('.write-lock/pwn.md')).toBe(true)
    expect(isReservedPath('.consolidate-lock/pwn.md')).toBe(true)
  })
})

describe('scanMemoryFiles 排除保留子树', () => {
  it('logs/ 下的 .md 不出现在结果里', async () => {
    fs.mkdirSync(path.join(dir, 'logs/2026/07/13'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'logs/2026/07/13/sess-abc.md'), '> 你好\n')
    fs.writeFileSync(path.join(dir, 'real.md'), '---\ndescription: 真记忆\n---\n内容\n')
    const heads = await scanMemoryFiles(dir)
    expect(heads.map(h => h.filename)).toEqual(['real.md'])
  })
})

describe('MemWrite/MemEdit 拒写保留子树与锁文件', () => {
  const tools = () => makeMemdirTools(dir)
  const memWrite = () => tools().find(t => t.name === 'MemWrite')!

  it('拒绝写 logs/', async () => {
    const r = await memWrite().call({ file_path: 'logs/2026/07/13/x.md', content: 'x' } as any, {} as any)
    expect(String(r)).toContain('拒绝')
    expect(fs.existsSync(path.join(dir, 'logs/2026/07/13/x.md'))).toBe(false)
  })

  it('拒绝写 .consolidate-lock', async () => {
    const r = await memWrite().call({ file_path: '.consolidate-lock', content: '1' } as any, {} as any)
    expect(String(r)).toContain('拒绝')
  })

  it('拒绝写 .write-lock', async () => {
    const r = await memWrite().call({ file_path: '.write-lock', content: '1' } as any, {} as any)
    expect(String(r)).toContain('拒绝')
  })

  it('用 ../ 绕回 logs/ 也被拒（归一化后判定）', async () => {
    const r = await memWrite().call({ file_path: 'a/../logs/x.md', content: 'x' } as any, {} as any)
    expect(String(r)).toContain('拒绝')
  })

  it('正常顶层记忆仍可写', async () => {
    const r = await memWrite().call({ file_path: 'ok.md', content: 'hi' } as any, {} as any)
    expect(String(r)).toContain('已写入')
  })

  it('拒绝写 .write-lock/ 子路径（M4：目录名撞保留文件名时不能靠巧合挡住）', async () => {
    const r = await memWrite().call({ file_path: '.write-lock/pwn.md', content: 'x' } as any, {} as any)
    expect(String(r)).toContain('拒绝')
    expect(fs.existsSync(path.join(dir, '.write-lock', 'pwn.md'))).toBe(false)
  })
})

describe('.index.md 保留', () => {
  it('.index.md 被视为保留文件', () => {
    expect(isReservedPath('.index.md')).toBe(true)
  })
  it('scanMemoryFiles 不把 .index.md 当记忆', async () => {
    fs.writeFileSync(path.join(dir, '.index.md'), '# 归纳索引\n- x')
    fs.writeFileSync(path.join(dir, 'real.md'), '---\ndescription: r\n---\nbody')
    const heads = await scanMemoryFiles(dir, 'project')
    expect(heads.some(h => h.filename === '.index.md')).toBe(false)
    expect(heads.some(h => h.filename === 'real.md')).toBe(true)
  })
})
