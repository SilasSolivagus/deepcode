// src/imageResize.ts — 视觉透传前把图片规范化到 API 尺寸限内（2000²/base64≤5MB）。
import { Jimp } from 'jimp'

export const MAX_DIM = 2000
export const MAX_B64 = 5_242_880 // 5MB base64 上限
const QUALITY_LADDER = [80, 60, 40, 20]

export class ImageTooLargeError extends Error {
  constructor() { super('图片过大，压缩后仍超出 API 限制'); this.name = 'ImageTooLargeError' }
}

/** 缩放/重编码到 ≤2000² 且 base64≤5MB。解码失败：原图≤5MB 原样过，否则抛。 */
export async function normalizeForVision(
  base64: string, mime: string,
): Promise<{ base64: string; mime: string }> {
  let image: Awaited<ReturnType<typeof Jimp.read>>
  try {
    image = await Jimp.read(Buffer.from(base64, 'base64'))
  } catch {
    if (base64.length <= MAX_B64) return { base64, mime }
    throw new ImageTooLargeError()
  }
  const inLimit = image.width <= MAX_DIM && image.height <= MAX_DIM && base64.length <= MAX_B64
  if (inLimit) return { base64, mime }
  if (image.width > MAX_DIM || image.height > MAX_DIM) image.scaleToFit({ w: MAX_DIM, h: MAX_DIM })
  for (const quality of QUALITY_LADDER) {
    const buf = await image.getBuffer('image/jpeg', { quality })
    const b64 = buf.toString('base64')
    if (b64.length <= MAX_B64) return { base64: b64, mime: 'image/jpeg' }
  }
  image.scaleToFit({ w: 1000, h: 1000 })
  const buf = await image.getBuffer('image/jpeg', { quality: 20 })
  const b64 = buf.toString('base64')
  if (b64.length <= MAX_B64) return { base64: b64, mime: 'image/jpeg' }
  throw new ImageTooLargeError()
}
