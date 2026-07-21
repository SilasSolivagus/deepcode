// src/tui/mouseStdin.ts
// 鼠标滚轮捕获（M8 P2）：终端开 SGR 鼠标模式后，滚轮/点击都以转义序列 \x1b[<b;x;y M/m 进入 stdin。
// ink 的 useInput 不解析鼠标，会把序列当普通文本塞进输入框。故在 ink 读取前过滤：剔除所有鼠标序列
// （避免污染输入框），其中滚轮（button 64=上、65=下）转成滚动方向回调，其余文本原样转发给 ink。
import { PassThrough } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { initPasteState, stripBracketedPaste, type PasteState } from './pasteBracket.js'

/** 纯函数（可单测）：剔除一段输入里的鼠标 SGR 序列，返回剩余转发文本 + 解析出的滚轮方向。 */
export function parseWheel(s: string): { forward: string; wheels: Array<'up' | 'down'> } {
  const wheels: Array<'up' | 'down'> = []
  const forward = s.replace(/\x1b\[<(\d+);\d+;\d+[Mm]/g, (_m, b) => {
    const btn = Number(b)
    if (btn === 64) wheels.push('up')
    else if (btn === 65) wheels.push('down')
    return '' // 所有鼠标序列都从转发流剔除
  })
  return { forward, wheels }
}

/**
 * 包一层过滤 stdin 喂给 ink：先剥括号粘贴标记（粘贴内 \r→\n），再（若给了 onWheel）把滚轮转 onWheel、
 * 剔除其余鼠标序列，其余按键原样转发。代理 tty 方法到真实 stdin。
 * onWheel 省略时（inline 模式无鼠标捕获）只做括号粘贴过滤。
 */
export function makeFilteredStdin(
  source: NodeJS.ReadStream,
  opts: { onWheel?: (dir: 'up' | 'down') => void } = {},
): { stdin: NodeJS.ReadStream; cleanup: () => void } {
  const pt = new PassThrough() as any
  pt.isTTY = source.isTTY
  pt.setRawMode = (mode: boolean) => { source.setRawMode?.(mode); return pt }
  pt.ref = () => { (source as any).ref?.(); return pt }
  pt.unref = () => { (source as any).unref?.(); return pt }

  // StringDecoder 跨块保留不完整的多字节 UTF-8 尾字节：大粘贴时终端把一个多字节字符（如「、」
  // = E3 80 81）拆到相邻 data 块，逐块 chunk.toString('utf8') 会把半个字符解成替换符（乱码）。
  // decoder.write 缓冲不完整尾字节到下次，重组完整字符。ASCII（含鼠标 SGR 序列）单字节即时透传，行为不变。
  const decoder = new StringDecoder('utf8')
  let pasteState: PasteState = initPasteState()
  const onData = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    const pr = stripBracketedPaste(pasteState, text)
    pasteState = pr.state
    let forward = pr.forward
    if (opts.onWheel) {
      const w = parseWheel(forward)
      for (const dir of w.wheels) opts.onWheel(dir)
      forward = w.forward
    }
    if (forward) pt.write(forward)
  }
  source.on('data', onData)

  return { stdin: pt as NodeJS.ReadStream, cleanup: () => { source.off('data', onData) } }
}

/** 向后兼容别名：鼠标滚轮 + 括号粘贴过滤（全屏模式）。 */
export function makeMouseFilteredStdin(
  source: NodeJS.ReadStream,
  onWheel: (dir: 'up' | 'down') => void,
): { stdin: NodeJS.ReadStream; cleanup: () => void } {
  return makeFilteredStdin(source, { onWheel })
}
