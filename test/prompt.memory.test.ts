import { describe, test, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { buildSystemPrompt } from '../src/prompt.js'

describe('buildSystemPrompt memdir 段', () => {
  let md: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-bsp-')) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }) })
  test('给 memdir → 注入记忆索引段', () => {
    fs.writeFileSync(path.join(md, 'MEMORY.md'), '- [x](x.md) — hook')
    const out = buildSystemPrompt(process.cwd(), os.homedir(), undefined, undefined, md)
    expect(out).toContain('## 记忆索引')
    expect(out).toContain('x.md')
  })
  test('不给 memdir → 无记忆索引段', () => {
    const out = buildSystemPrompt(process.cwd(), os.homedir())
    expect(out).not.toContain('## 记忆索引')
  })
})

it('skipMemory=true 时略过项目记忆', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dc-skipmem-'))
  writeFileSync(path.join(dir, 'DEEPCODE.md'), '# 项目秘密记忆XYZ')
  const withMem = buildSystemPrompt(dir, '/nonexistent-home')
  const without = buildSystemPrompt(dir, '/nonexistent-home', undefined, undefined, undefined, undefined, undefined, true)
  expect(withMem).toContain('项目秘密记忆XYZ')
  expect(without).not.toContain('项目秘密记忆XYZ')
})

test('全局记忆全文进系统提示（不需要模型 Read）', () => {
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-gp-'))
  fs.writeFileSync(path.join(g, 'tw.md'), '---\ntype: user\n---\n不喜欢 tailwind。')
  const out = buildSystemPrompt(process.cwd(), '/nonexistent-home', undefined, undefined, undefined, undefined, undefined, undefined, undefined, g)
  expect(out).toContain('不喜欢 tailwind。')
  fs.rmSync(g, { recursive: true, force: true })
})

test('memoryPaused 时全局记忆也不注入', () => {
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-gp2-'))
  fs.writeFileSync(path.join(g, 'tw.md'), '不喜欢 tailwind。')
  const out = buildSystemPrompt(process.cwd(), '/nonexistent-home', undefined, undefined, undefined, undefined, undefined, true, undefined, g)
  expect(out).not.toContain('不喜欢 tailwind。')
  fs.rmSync(g, { recursive: true, force: true })
})
