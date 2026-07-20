import { it, expect, vi } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const parseMock = vi.fn(async (..._a: any[]) => ({ markdown: '# 解析结果\n正文', numPages: 2 }))
vi.mock('../src/docParse.js', async () => {
  const actual = await vi.importActual<typeof import('../src/docParse.js')>('../src/docParse.js')
  return { ...actual, parseDocument: (...a: any[]) => parseMock(...a) }
})

import { readTool } from '../src/tools/read.js'
import { GlmKeyMissingError } from '../src/imageDescribe.js'
import { DocParseTimeoutError } from '../src/docParse.js'

const ctx: any = { cwd: () => '/', fileState: new Map() }

it('Read .pdf → GLM-OCR markdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dc-rd-'))
  const p = join(dir, 'a.pdf'); writeFileSync(p, '%PDF fake')
  const out = await readTool.call({ file_path: p } as any, ctx)
  expect(parseMock).toHaveBeenCalled()
  expect(out).toContain('# 解析结果')
})

it('Read .png → GLM-OCR markdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dc-rd-'))
  const p = join(dir, 'a.png'); writeFileSync(p, 'fakepng')
  const out = await readTool.call({ file_path: p } as any, ctx)
  expect(out).toContain('# 解析结果')
})

it('Read .txt 仍走纯文本（回归）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dc-rd-'))
  const p = join(dir, 'a.txt'); writeFileSync(p, 'line1\nline2')
  const out = await readTool.call({ file_path: p } as any, ctx)
  expect(out).toContain('1\tline1')
})

it('解析抛 GlmKeyMissingError → 返回错误字符串不抛', async () => {
  parseMock.mockRejectedValueOnce(new GlmKeyMissingError())
  const dir = mkdtempSync(join(tmpdir(), 'dc-rd-'))
  const p = join(dir, 'b.pdf'); writeFileSync(p, '%PDF')
  const out = await readTool.call({ file_path: p } as any, ctx)
  expect(out).toContain('无法解析')
})

it('解析抛 DocParseTimeoutError → 返回超时错误字符串', async () => {
  parseMock.mockRejectedValueOnce(new DocParseTimeoutError())
  const dir = mkdtempSync(join(tmpdir(), 'dc-rd-'))
  const p = join(dir, 'c.pdf'); writeFileSync(p, '%PDF')
  const out = await readTool.call({ file_path: p } as any, ctx)
  expect(out).toContain('解析超时')
})
