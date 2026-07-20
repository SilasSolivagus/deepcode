import { describe, it, expect } from 'vitest'
import {
  graphemes, prevGraphemeBoundary, nextGraphemeBoundary,
  placeholderAt, placeholderStartingAt, placeholderEndingAt,
} from '../src/tui/editCursor.js'
import { left, right, wordLeft, wordRight, toStart, toEnd, clamp } from '../src/tui/editCursor.js'
import { insert, backspace, del, deleteWordBefore, deleteWordAfter, deleteToStart, deleteToEnd } from '../src/tui/editCursor.js'

describe('批1 Task1: 字素 + 占位符检测', () => {
  it('graphemes 按字素簇切分（emoji 不撕裂）', () => {
    expect(graphemes('a你b')).toEqual(['a', '你', 'b'])
    expect(graphemes('👨‍👩‍👧')).toEqual(['👨‍👩‍👧']) // ZWJ family = 1 grapheme
  })
  it('prev/nextGraphemeBoundary 跨字素/emoji', () => {
    const s = 'a👨‍👩‍👧b'
    // 'a'=1, family=至 1+len(family), 'b'
    expect(prevGraphemeBoundary(s, 1)).toBe(0)              // 'a' 前边界
    expect(nextGraphemeBoundary(s, 0)).toBe(1)              // 'a' 后边界
    const famEnd = 1 + '👨‍👩‍👧'.length
    expect(nextGraphemeBoundary(s, 1)).toBe(famEnd)         // 跨整个 family
    expect(prevGraphemeBoundary(s, famEnd)).toBe(1)         // 回退整个 family
  })
  it('边界夹取：0 处 prev 返 0，末尾 next 返 len', () => {
    expect(prevGraphemeBoundary('abc', 0)).toBe(0)
    expect(nextGraphemeBoundary('abc', 3)).toBe(3)
  })
  it('placeholderAt：pos 严格在 token 内 → 命中；边界/外 → null', () => {
    const v = 'x[Image #1]y' // token 在 [1,11)
    expect(placeholderAt(v, 5)).toEqual({ start: 1, end: 11 })
    expect(placeholderAt(v, 1)).toBeNull()   // 起始边界不算「内」
    expect(placeholderAt(v, 11)).toBeNull()  // 结束边界不算「内」
    expect(placeholderAt(v, 0)).toBeNull()
  })
  it('placeholderStartingAt / EndingAt', () => {
    const v = 'x[Pasted text #2 +5 lines]y' // 计算 token 边界
    const start = v.indexOf('[')
    const end = v.indexOf(']') + 1
    expect(placeholderStartingAt(v, start)).toEqual({ start, end })
    expect(placeholderEndingAt(v, end)).toEqual({ start, end })
    expect(placeholderStartingAt(v, start + 1)).toBeNull()
  })
  it('Truncated 变体也识别', () => {
    const v = '[...Truncated text #3 +10 lines...]'
    expect(placeholderStartingAt(v, 0)).toEqual({ start: 0, end: v.length })
  })
})

describe('批1 Task2: 光标移动', () => {
  const at = (value: string, cursor: number) => ({ value, cursor })
  it('left/right 逐字素', () => {
    expect(right(at('a你b', 0)).cursor).toBe(1)       // 过 'a'
    expect(right(at('a你b', 1)).cursor).toBe(2)       // 过 '你'（UTF-16 1 单元）
    expect(left(at('a你b', 2)).cursor).toBe(1)
    expect(left(at('abc', 0)).cursor).toBe(0)         // 首端不动
    expect(right(at('abc', 3)).cursor).toBe(3)        // 末端不动
  })
  it('left/right 占位符原子 snap（不落 token 内）', () => {
    const v = 'x[Image #1]y'
    const end = v.indexOf(']') + 1  // token 末
    // 光标在 token 末，left 一下 → 跳到 token 首（1），不进内部
    expect(left(at(v, end)).cursor).toBe(1)
    // 光标在 token 首（1），right 一下 → 跳到 token 末
    expect(right(at(v, 1)).cursor).toBe(end)
  })
  it('wordLeft/wordRight 按词（含 CJK 与数字）', () => {
    const v = 'foo bar 你好'
    // 末尾 wordLeft → '你好' 词首
    const wl = wordLeft(at(v, v.length))
    expect(v.slice(wl.cursor)).toBe('你好')
    // 从 0 wordRight → 下一词 'bar' 词首（CC nextWord 语义，含尾空格）
    const wr = wordRight(at(v, 0))
    expect(v.slice(0, wr.cursor)).toBe('foo ')
  })
  it('wordLeft/Right 占位符视为一个词', () => {
    const v = 'a [Image #1] b'
    const tokStart = v.indexOf('[')
    const tokEnd = v.indexOf(']') + 1
    // 从 token 后 wordLeft 跳过整个 token
    const wl = wordLeft(at(v, tokEnd))
    expect(wl.cursor).toBeLessThanOrEqual(tokStart)
  })
  it('toStart/toEnd', () => {
    expect(toStart(at('abc', 2)).cursor).toBe(0)
    expect(toEnd(at('abc', 1)).cursor).toBe(3)
  })
  it('clamp 吸附字素边界 + 吸出 token 内', () => {
    expect(clamp('abc', 5)).toBe(3)
    expect(clamp('abc', -1)).toBe(0)
    const v = 'x[Image #1]y'
    expect(clamp(v, 5)).toBe(v.indexOf(']') + 1) // token 内 → 吸到 token 末
  })
})

describe('批1 Task3: 编辑', () => {
  const at = (value: string, cursor: number) => ({ value, cursor })
  it('insert 到光标（NFC，光标前移）', () => {
    const r = insert(at('ac', 1), 'b')
    expect(r).toEqual({ value: 'abc', cursor: 2 })
  })
  it('backspace 删前字素；首端无操作', () => {
    expect(backspace(at('abc', 2))).toEqual({ value: 'ac', cursor: 1 })
    expect(backspace(at('你好', 1))).toEqual({ value: '好', cursor: 0 }) // 删整个 '你'
    expect(backspace(at('abc', 0))).toEqual({ value: 'abc', cursor: 0 })
  })
  it('backspace 前置占位符整删（v1 只删 token 本体，不删尾空格）', () => {
    const v = '[Image #1] x'
    const tokEnd = v.indexOf(']') + 1
    // 光标在 token 后的空格后（假设在 tokEnd+1，即空格后）
    const r = backspace(at(v, tokEnd)) // 光标紧贴 token 末
    expect(r.value).toBe(' x')         // 整删 token（保留其后空格与 x）
    expect(r.cursor).toBe(0)
  })
  it('del 删后字素；末端无操作', () => {
    expect(del(at('abc', 1))).toEqual({ value: 'ac', cursor: 1 })
    expect(del(at('abc', 3))).toEqual({ value: 'abc', cursor: 3 })
  })
  it('del 当前占位符整删', () => {
    const v = 'x[Image #1]y'
    const tokStart = v.indexOf('[')
    const r = del(at(v, tokStart))
    expect(r.value).toBe('xy')
    expect(r.cursor).toBe(tokStart)
  })
  it('deleteWordBefore 返回 killed', () => {
    const r = deleteWordBefore(at('foo bar', 7))
    expect(r.cur.value).toBe('foo ')
    expect(r.killed).toBe('bar')
  })
  it('deleteWordAfter 返回 killed', () => {
    const r = deleteWordAfter(at('foo bar', 0))
    expect(r.cur.value).toBe('bar')
    expect(r.killed).toBe('foo ')
  })
  it('deleteToStart / deleteToEnd', () => {
    expect(deleteToStart(at('abcdef', 3))).toEqual({ cur: { value: 'def', cursor: 0 }, killed: 'abc' })
    expect(deleteToEnd(at('abcdef', 3))).toEqual({ cur: { value: 'abc', cursor: 3 }, killed: 'def' })
  })
})
