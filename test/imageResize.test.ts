import { it, expect } from 'vitest'
import { Jimp } from 'jimp'
import { normalizeForVision, ImageTooLargeError, MAX_B64 } from '../src/imageResize.js'

// 用 jimp 现造测试图，避免二进制 fixture
async function pngBase64(w: number, h: number): Promise<string> {
  const img = new Jimp({ width: w, height: h, color: 0xff0000ff })
  const buf = await img.getBuffer('image/png')
  return buf.toString('base64')
}

it('小图（限内）原样返回，mime 不变', async () => {
  const b64 = await pngBase64(100, 100)
  const out = await normalizeForVision(b64, 'image/png')
  expect(out.base64).toBe(b64)
  expect(out.mime).toBe('image/png')
})

it('超维度大图缩到 ≤2000² 且 base64≤5MB', async () => {
  const b64 = await pngBase64(3000, 2500)
  const out = await normalizeForVision(b64, 'image/png')
  const back = await Jimp.read(Buffer.from(out.base64, 'base64'))
  expect(back.width).toBeLessThanOrEqual(2000)
  expect(back.height).toBeLessThanOrEqual(2000)
  expect(out.base64.length).toBeLessThanOrEqual(MAX_B64)
})

it('解码失败但原图≤5MB → 原样返回', async () => {
  const out = await normalizeForVision('bm90LWFuLWltYWdl', 'image/png') // "not-an-image"
  expect(out.base64).toBe('bm90LWFuLWltYWdl')
  expect(out.mime).toBe('image/png')
})

it('解码失败且原图>5MB → 抛 ImageTooLargeError', async () => {
  const huge = 'A'.repeat(MAX_B64 + 1)
  await expect(normalizeForVision(huge, 'image/png')).rejects.toBeInstanceOf(ImageTooLargeError)
})
