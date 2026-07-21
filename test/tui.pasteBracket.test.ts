import { describe, it, expect } from 'vitest'
import { initPasteState, stripBracketedPaste } from '../src/tui/pasteBracket.js'

const START = '\x1b[200~'
const END = '\x1b[201~'

// 便捷：把一串 chunks 顺序喂进状态机，拼接 forward。
function run(chunks: string[]) {
  let st = initPasteState()
  let out = ''
  for (const c of chunks) {
    const r = stripBracketedPaste(st, c)
    out += r.forward
    st = r.state
  }
  return { out, st }
}

describe('stripBracketedPaste：剥离括号粘贴标记 + 粘贴内 \\r→\\n', () => {
  it('无标记 → 原样转发', () => {
    expect(run(['hello']).out).toBe('hello')
  })
  it('单块完整粘贴 → 剥标记，内容保留', () => {
    expect(run([`${START}foo bar${END}`]).out).toBe('foo bar')
  })
  it('粘贴内的 \\r 转为 \\n（隔离的回车不会误提交）', () => {
    expect(run([`${START}a\rb${END}`]).out).toBe('a\nb')
  })
  it('粘贴外的 \\r 保留（真实回车照常提交）', () => {
    expect(run(['x\r']).out).toBe('x\r')
  })
  it('标记跨块分裂（200~ 拆两块）→ 正确识别', () => {
    expect(run(['\x1b[20', `0~payload${END}`]).out).toBe('payload')
  })
  it('结束标记跨块分裂 → 正确识别，粘贴态在块间保持', () => {
    const r = run([`${START}ab`, '\x1b[2', '01~cd'])
    expect(r.out).toBe('abcd')
    expect(r.st.inPaste).toBe(false)
  })
  it('粘贴态跨块保持：中间块的 \\r 也转 \\n', () => {
    const r = run([`${START}a`, '\rb', END])
    expect(r.out).toBe('a\nb')
  })
  it('孤立的 \\x1b（Esc 键）不被吞：立即转发，不进 carry', () => {
    const r = run(['\x1b'])
    expect(r.out).toBe('\x1b')
    expect(r.st.carry).toBe('')
  })
  it('非粘贴的 CSI 序列（方向键 \\x1b[A）原样透传', () => {
    expect(run(['\x1b[A']).out).toBe('\x1b[A')
  })
  it('粘贴内 \\r\\n 归一为单个 \\n（不产生多余空行）', () => {
    expect(run([`${START}line1\r\nline2${END}`]).out).toBe('line1\nline2')
  })
  it('粘贴内 \\r\\n 跨块分裂（\\r 结尾、\\n 开头）仍归一为单 \\n', () => {
    expect(run([`${START}a\r`, `b${END}`]).out).toBe('a\nb')
  })
})
