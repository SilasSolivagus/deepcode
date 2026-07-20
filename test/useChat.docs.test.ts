import { it, expect, vi } from 'vitest'
import { resolveDocPlaceholders } from '../src/tui/useChat.js'
import { DocParseTimeoutError } from '../src/docParse.js'

it('把 [Doc #N] 替换成 GLM-OCR markdown 注入 + onStart/onEnd 进度回调', async () => {
  const parse = vi.fn(async () => ({ markdown: '# 报告\n第一段', numPages: 2 }))
  const onStart = vi.fn()
  const onEnd = vi.fn()
  const attachments = [{ id: 1, type: 'doc' as const, base64: 'AAAA', mime: 'application/pdf', filename: 'r.pdf' }]
  const out = await resolveDocPlaceholders('看这份 [Doc #1]', attachments, { parse, onStart, onEnd })
  expect(parse).toHaveBeenCalledOnce()
  expect(out).toContain('<文档#1 解析(glm-ocr)>')
  expect(out).toContain('# 报告\n第一段')
  expect(out).not.toContain('[Doc #1]')
  expect(onStart).toHaveBeenCalledWith(1)
  expect(onEnd).toHaveBeenCalledWith(1, true)
})

it('解析失败 → 替换成无法解析 + onError + onEnd(id, false)', async () => {
  const parse = vi.fn(async () => { throw new Error('boom') })
  const onError = vi.fn()
  const onEnd = vi.fn()
  const attachments = [{ id: 2, type: 'doc' as const, base64: 'A', mime: 'application/pdf', filename: 'x.pdf' }]
  const out = await resolveDocPlaceholders('[Doc #2]', attachments, { parse, onError, onEnd })
  expect(out).toContain('无法解析')
  expect(onError).toHaveBeenCalled()
  expect(out).not.toContain('[Doc #2]')
  expect(onEnd).toHaveBeenCalledWith(2, false)
})

it('解析超时 → 替换成超时文案', async () => {
  const parse = vi.fn(async () => { throw new DocParseTimeoutError() })
  const attachments = [{ id: 3, type: 'doc' as const, base64: 'A', mime: 'application/pdf', filename: 'x.pdf' }]
  const out = await resolveDocPlaceholders('[Doc #3]', attachments, { parse })
  expect(out).toContain('解析超时')
})

it('无 doc 附件 → 原样返回', async () => {
  const out = await resolveDocPlaceholders('纯文本', [], {})
  expect(out).toBe('纯文本')
})
