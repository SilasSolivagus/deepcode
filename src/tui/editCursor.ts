// src/tui/editCursor.ts
// 文本编辑纯逻辑：字素/词/占位符感知的光标移动与编辑。无 React/副作用。
// 光标 cursor = 字素边界处的字符串索引（UTF-16 code unit 偏移，但只落在字素簇边界）。

export interface Cur { value: string; cursor: number }

const graphemeSeg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const wordSeg = new Intl.Segmenter(undefined, { granularity: 'word' })
const HAS_NUMBER = /\p{N}/u

/** 占位符 token 文法：与 pasteFold.makePlaceholder + InputBox [Image #N] 同步。 */
const PLACEHOLDER_RE = /\[(?:Pasted text #\d+(?: \+\d+ lines)?|\.\.\.Truncated text #\d+ \+\d+ lines\.\.\.|Image #\d+)\]/g

export function graphemes(s: string): string[] {
  return [...graphemeSeg.segment(s)].map(seg => seg.segment)
}

/** i 之前最近的字素边界（i<=0 → 0）。 */
export function prevGraphemeBoundary(s: string, i: number): number {
  if (i <= 0) return 0
  let last = 0
  for (const seg of graphemeSeg.segment(s)) {
    if (seg.index >= i) break
    last = seg.index
  }
  return last
}

/** i 之后最近的字素边界（i>=len → len）。 */
export function nextGraphemeBoundary(s: string, i: number): number {
  if (i >= s.length) return s.length
  for (const seg of graphemeSeg.segment(s)) {
    const end = seg.index + seg.segment.length
    if (end > i) return end
  }
  return s.length
}

export function eachToken(value: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  for (const m of value.matchAll(PLACEHOLDER_RE)) {
    out.push({ start: m.index!, end: m.index! + m[0].length })
  }
  return out
}

export function placeholderAt(value: string, pos: number): { start: number; end: number } | null {
  for (const t of eachToken(value)) if (pos > t.start && pos < t.end) return t
  return null
}
export function placeholderStartingAt(value: string, pos: number): { start: number; end: number } | null {
  for (const t of eachToken(value)) if (t.start === pos) return t
  return null
}
export function placeholderEndingAt(value: string, pos: number): { start: number; end: number } | null {
  for (const t of eachToken(value)) if (t.end === pos) return t
  return null
}

// 供后续 Task 使用（本 Task 不导出更多）——词判定
export function isWordLikeSegment(seg: { segment: string; isWordLike?: boolean }): boolean {
  return !!seg.isWordLike || HAS_NUMBER.test(seg.segment)
}
export { wordSeg }

/**
 * 把任意 (value, cursor) 校正到「字素边界 + 占位符 token 外」的合法光标位置。
 * ⚠️ 集成契约（批 2/3 接线必读）：本模块的 left、right、wordLeft、wordRight、backspace、del 等**不自愈**——它们假设
 * cursor 已落在字素边界且不在 token 内，仅在此前提下维持占位符原子性。任何**不是**由本模块函数产出的
 * (value, cursor)——历史↑↓ 载入、valueOverride 注入、初始挂载、手拼的粘贴后 value——**必须先过 clamp**，
 * 否则 cursor 可能卡进 token 内部，后续 left/right/backspace 会逐字符走进 token（悄悄破坏原子性）。
 */
export function clamp(value: string, cursor: number): number {
  const c = Math.max(0, Math.min(value.length, cursor))
  const tok = placeholderAt(value, c)
  if (tok) return tok.end // token 内 → 吸到末（token 边界本身即字素边界，无需再吸附）
  // 吸附字素边界（若 c 落在字素簇中间，回退到边界）
  const b = prevGraphemeBoundary(value, c)
  const n = nextGraphemeBoundary(value, c)
  return c - b <= n - c ? b : n
}

export function left(c: Cur): Cur {
  if (c.cursor <= 0) return c
  const endTok = placeholderEndingAt(c.value, c.cursor)
  if (endTok) return { value: c.value, cursor: endTok.start } // 原子跳到 token 首
  return { value: c.value, cursor: prevGraphemeBoundary(c.value, c.cursor) }
}

export function right(c: Cur): Cur {
  if (c.cursor >= c.value.length) return c
  const startTok = placeholderStartingAt(c.value, c.cursor)
  if (startTok) return { value: c.value, cursor: startTok.end } // 原子跳到 token 末
  return { value: c.value, cursor: nextGraphemeBoundary(c.value, c.cursor) }
}

/** value 的词边界列表（占位符 token 作为一个词单元覆盖普通分词）。 */
function wordBoundaries(value: string): Array<{ start: number; end: number }> {
  const toks = eachToken(value)
  const inTok = (i: number) => toks.find(t => i >= t.start && i < t.end)
  const out: Array<{ start: number; end: number }> = []
  for (const seg of wordSeg.segment(value)) {
    const t = inTok(seg.index)
    if (t) { if (!out.some(o => o.start === t.start)) out.push({ start: t.start, end: t.end }); continue }
    if (isWordLikeSegment(seg)) out.push({ start: seg.index, end: seg.index + seg.segment.length })
  }
  return out
}

export function wordLeft(c: Cur): Cur {
  const bs = wordBoundaries(c.value)
  let target = 0
  for (const b of bs) if (b.start < c.cursor) target = b.start; else break
  return { value: c.value, cursor: target }
}
export function wordRight(c: Cur): Cur {
  const bs = wordBoundaries(c.value)
  for (const b of bs) if (b.start > c.cursor) return { value: c.value, cursor: b.start }
  return { value: c.value, cursor: c.value.length }
}

export function toStart(c: Cur): Cur { return { value: c.value, cursor: 0 } }
export function toEnd(c: Cur): Cur { return { value: c.value, cursor: c.value.length } }

export function insert(c: Cur, text: string): Cur {
  const t = text.normalize('NFC')
  return { value: c.value.slice(0, c.cursor) + t + c.value.slice(c.cursor), cursor: c.cursor + t.length }
}

export function backspace(c: Cur): Cur {
  if (c.cursor <= 0) return c
  const tok = placeholderEndingAt(c.value, c.cursor)
  if (tok) return { value: c.value.slice(0, tok.start) + c.value.slice(tok.end), cursor: tok.start } // 整删 token
  const b = prevGraphemeBoundary(c.value, c.cursor)
  return { value: c.value.slice(0, b) + c.value.slice(c.cursor), cursor: b }
}

export function del(c: Cur): Cur {
  if (c.cursor >= c.value.length) return c
  const tok = placeholderStartingAt(c.value, c.cursor)
  if (tok) return { value: c.value.slice(0, tok.start) + c.value.slice(tok.end), cursor: c.cursor } // 整删 token
  const n = nextGraphemeBoundary(c.value, c.cursor)
  return { value: c.value.slice(0, c.cursor) + c.value.slice(n), cursor: c.cursor }
}

export function deleteWordBefore(c: Cur): { cur: Cur; killed: string } {
  const target = wordLeft(c).cursor
  const killed = c.value.slice(target, c.cursor)
  return { cur: { value: c.value.slice(0, target) + c.value.slice(c.cursor), cursor: target }, killed }
}
export function deleteWordAfter(c: Cur): { cur: Cur; killed: string } {
  const target = wordRight(c).cursor
  const killed = c.value.slice(c.cursor, target)
  return { cur: { value: c.value.slice(0, c.cursor) + c.value.slice(target), cursor: c.cursor }, killed }
}
export function deleteToStart(c: Cur): { cur: Cur; killed: string } {
  const killed = c.value.slice(0, c.cursor)
  return { cur: { value: c.value.slice(c.cursor), cursor: 0 }, killed }
}
export function deleteToEnd(c: Cur): { cur: Cur; killed: string } {
  const killed = c.value.slice(c.cursor)
  return { cur: { value: c.value.slice(0, c.cursor), cursor: c.cursor }, killed }
}

/** 渲染切分：before + 光标处一字素(at) + after。末尾 at='' → 渲染时反色一个空格。 */
export function splitAtCursor(value: string, cursor: number): { before: string; at: string; after: string } {
  const before = value.slice(0, cursor)
  if (cursor >= value.length) return { before, at: '', after: '' }
  const n = nextGraphemeBoundary(value, cursor)
  return { before, at: value.slice(cursor, n), after: value.slice(n) }
}
