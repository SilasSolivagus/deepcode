// src/tui/pasteBracket.ts
// 括号粘贴（bracketed paste, DEC ?2004）过滤：终端开 ?2004h 后，粘贴内容被 \x1b[200~ … \x1b[201~
// 包裹。ink 5.2.1 不识别这两个标记，会把它们当乱码塞进输入框，且粘贴里内嵌的回车会被当成提交。
// 本模块在 ink 读取前的 stdin 流上剥掉标记，并把「粘贴态内」的 \r 归一为 \n：
//   - \r\n → \n（避免多余空行）、孤立 \r → \n（隔离的回车经 InputBox 的 Ctrl+J 分支变成换行插入而非提交）
//   - 粘贴态外的 \r 原样保留（真实回车照常提交）
// 纯函数、状态显式传入，可单测（同 mouseStdin 的 parseWheel）。标记 6 字节，终端通常原子写入；
// 少数跨块分裂的场景用 carry 兜底（只 carry ≥2 字节的标记前缀或粘贴态末尾的 \r，孤立 \x1b=Esc 键立即转发不吞）。

const START = '\x1b[200~'
const END = '\x1b[201~'

export interface PasteState {
  inPaste: boolean
  /** 跨块暂存：上一块结尾可能是半个标记的前缀，或粘贴态里待判定 \r\n 的孤立 \r */
  carry: string
}

export function initPasteState(): PasteState {
  return { inPaste: false, carry: '' }
}

/** 是不是某个标记的「真前缀」（比完整标记短、且长度≥2，排除孤立 \x1b 以免吞掉 Esc 键）。 */
function isPartialMarker(tail: string): boolean {
  if (tail.length < 2 || tail.length >= START.length) return false
  return START.startsWith(tail) || END.startsWith(tail)
}

export function stripBracketedPaste(
  state: PasteState, chunk: string,
): { forward: string; state: PasteState } {
  const buf = state.carry + chunk
  let inPaste = state.inPaste
  let forward = ''
  let i = 0
  while (i < buf.length) {
    if (buf[i] === '\x1b') {
      if (buf.startsWith(START, i)) { inPaste = true; i += START.length; continue }
      if (buf.startsWith(END, i)) { inPaste = false; i += END.length; continue }
      const tail = buf.slice(i)
      if (isPartialMarker(tail)) return { forward, state: { inPaste, carry: tail } }
      forward += buf[i]; i++   // 真实 ESC 序列（方向键等）/ 孤立 Esc：原样转发
      continue
    }
    if (inPaste && buf[i] === '\r') {
      const next = buf[i + 1]
      if (next === undefined) return { forward, state: { inPaste, carry: '\r' } } // \r 结尾 → carry 判 \r\n
      if (next === '\n') { i++; continue }  // \r\n → 跳过 \r，下一轮吐 \n
      forward += '\n'; i++                  // 孤立 \r → \n
      continue
    }
    forward += buf[i]; i++
  }
  return { forward, state: { inPaste, carry: '' } }
}
