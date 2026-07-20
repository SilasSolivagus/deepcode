import { it, expect } from 'vitest'
import { toWireMessages } from '../src/api.js'

const imgMsg = {
  role: 'user',
  content: '看这张图 [Image #1]',
  images: [{ base64: 'AAAA', mime: 'image/png' }],
}

it('supportsVision=true：content 变块数组，文本块在前、image_url 块随后，images 键剥除', () => {
  const [m] = toWireMessages([imgMsg], true)
  expect(Array.isArray(m.content)).toBe(true)
  expect(m.content[0]).toEqual({ type: 'text', text: '看这张图 [Image #1]' })
  expect(m.content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } })
  expect(m.images).toBeUndefined()
})

it('supportsVision=false：content 仍是字符串，images 键剥除', () => {
  const [m] = toWireMessages([imgMsg], false)
  expect(m.content).toBe('看这张图 [Image #1]')
  expect(m.images).toBeUndefined()
})

it('无 images 的消息原样返回', () => {
  const plain = { role: 'user', content: '纯文本' }
  const [m] = toWireMessages([plain], true)
  expect(m.content).toBe('纯文本')
})

it('多图按序追加', () => {
  const two = { role: 'user', content: 't', images: [{ base64: 'A', mime: 'image/png' }, { base64: 'B', mime: 'image/jpeg' }] }
  const [m] = toWireMessages([two], true)
  expect(m.content.length).toBe(3)
  expect(m.content[2].image_url.url).toBe('data:image/jpeg;base64,B')
})
