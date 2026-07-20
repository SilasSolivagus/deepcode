import { it, expect } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDF_EXT_RE, readDocFile } from '../src/clipboardImage.js'

it('PDF_EXT_RE 匹配 .pdf 不匹配图片', () => {
  expect(PDF_EXT_RE.test('/x/a.pdf')).toBe(true)
  expect(PDF_EXT_RE.test('/x/a.PDF')).toBe(true)
  expect(PDF_EXT_RE.test('/x/a.png')).toBe(false)
})

it('readDocFile 读真 PDF → base64/mime/filename', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dc-doc-'))
  const p = join(dir, 'test.pdf')
  writeFileSync(p, '%PDF-1.4 fake') // 内容不必是合法 PDF，readDocFile 只读字节
  const r = readDocFile(p)
  expect(r).not.toBeNull()
  expect(r!.mime).toBe('application/pdf')
  expect(r!.filename).toBe('test.pdf')
  expect(Buffer.from(r!.base64, 'base64').toString()).toBe('%PDF-1.4 fake')
})

it('readDocFile 非 pdf → null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dc-doc-'))
  const p = join(dir, 'test.txt')
  writeFileSync(p, 'hi')
  expect(readDocFile(p)).toBeNull()
})
