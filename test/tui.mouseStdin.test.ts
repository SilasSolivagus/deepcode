import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { parseWheel, makeMouseFilteredStdin } from '../src/tui/mouseStdin.js'

describe('parseWheel', () => {
  it('提取滚轮上/下，转发剔除', () => {
    expect(parseWheel('\x1b[<64;10;5M')).toEqual({ forward: '', wheels: ['up'] })
    expect(parseWheel('\x1b[<65;10;5M')).toEqual({ forward: '', wheels: ['down'] })
  })

  it('普通按键原样转发，不误判', () => {
    expect(parseWheel('abc')).toEqual({ forward: 'abc', wheels: [] })
    expect(parseWheel('\x1b[A')).toEqual({ forward: '\x1b[A', wheels: [] })  // 上箭头
    expect(parseWheel('\x1b[5~')).toEqual({ forward: '\x1b[5~', wheels: [] }) // PageUp
  })

  it('混合：按键保留、滚轮剔除并解析', () => {
    const r = parseWheel('a\x1b[<64;1;1Mb')
    expect(r.forward).toBe('ab')
    expect(r.wheels).toEqual(['up'])
  })

  it('连续多个滚轮事件', () => {
    const r = parseWheel('\x1b[<65;1;1M\x1b[<65;1;1M\x1b[<64;1;1M')
    expect(r.wheels).toEqual(['down', 'down', 'up'])
    expect(r.forward).toBe('')
  })

  it('非滚轮鼠标（点击 button 0）也剔除、不触发滚动', () => {
    const r = parseWheel('\x1b[<0;1;1M')
    expect(r.forward).toBe('')
    expect(r.wheels).toEqual([])
  })
})

describe('makeMouseFilteredStdin 多字节 UTF-8 跨块重组', () => {
  it('多字节字符被拆到两个 stdin 块时，转发流仍还原完整字符（不乱码）', async () => {
    const source = new PassThrough() as any
    source.isTTY = true
    const { stdin, cleanup } = makeMouseFilteredStdin(source, () => {})
    let out = ''
    stdin.on('data', (d: Buffer | string) => { out += typeof d === 'string' ? d : d.toString('utf8') })
    // '、' = E3 80 81（3 字节）。拆在块边界：块1='a'+E3；块2=80 81+'b'
    const bytes = Buffer.from('a、b', 'utf8')
    source.write(bytes.subarray(0, 2))
    source.write(bytes.subarray(2))
    await new Promise(r => setImmediate(r))
    cleanup()
    expect(out).toBe('a、b')
  })

  it('单块内的完整多字节文本原样转发', async () => {
    const source = new PassThrough() as any
    source.isTTY = true
    const { stdin, cleanup } = makeMouseFilteredStdin(source, () => {})
    let out = ''
    stdin.on('data', (d: Buffer | string) => { out += typeof d === 'string' ? d : d.toString('utf8') })
    source.write(Buffer.from('Java、C++、Ruby', 'utf8'))
    await new Promise(r => setImmediate(r))
    cleanup()
    expect(out).toBe('Java、C++、Ruby')
  })
})
