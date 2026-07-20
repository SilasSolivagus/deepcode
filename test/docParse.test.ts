import { it, expect } from 'vitest'
import { vi } from 'vitest'

vi.mock('../src/config.js', () => ({ loadSettings: () => ({ providers: { glm: { apiKey: 'sk-glm-test' } } }) }))

import { parseDocument, DocParseTimeoutError } from '../src/docParse.js'

function fakeFetch(body: any, ok = true, status = 200) {
  return (async () => ({ ok, status, json: async () => body })) as any
}

it('调 GLM-OCR 返回 markdown + numPages，URL/body 正确', async () => {
  let capturedUrl = '', capturedBody: any
  const f = (async (url: string, opts: any) => { capturedUrl = url; capturedBody = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ md_results: '# 标题\n正文', data_info: { num_pages: 3 } }) } }) as any
  const out = await parseDocument('AAAA', 'application/pdf', { fetchImpl: f })
  expect(out.markdown).toBe('# 标题\n正文')
  expect(out.numPages).toBe(3)
  expect(capturedUrl).toContain('/layout_parsing')
  expect(capturedBody.model).toBe('glm-ocr')
})

it('响应无 md_results → 抛错', async () => {
  await expect(parseDocument('AAAA', 'application/pdf', { fetchImpl: fakeFetch({ data_info: {} }) }))
    .rejects.toThrow('md_results')
})

it('HTTP 非 2xx → 抛错', async () => {
  await expect(parseDocument('AAAA', 'application/pdf', { fetchImpl: fakeFetch({}, false, 500) }))
    .rejects.toThrow('HTTP 500')
})

it('fetch 超时 → 抛 DocParseTimeoutError', async () => {
  const f = (async () => { const e: any = new Error('x'); e.name = 'TimeoutError'; throw e }) as any
  await expect(parseDocument('AAAA', 'application/pdf', { fetchImpl: f }))
    .rejects.toBeInstanceOf(DocParseTimeoutError)
})
