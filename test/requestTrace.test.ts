import { describe, it, expect, vi } from 'vitest'
import { buildTraceRecord, nextSeq, writeTraceRecord } from '../src/requestTrace.js'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const base = {
  seq: 8,
  ts: '2026-08-01T12:34:56.789Z',
  model: 'deepseek-v4-pro',
  wireMessages: [{ role: 'user', content: 'hi' }],
  tools: [{ type: 'function', function: { name: 'Read' } }],
  params: { stream: true, stream_options: { include_usage: true } },
}

describe('buildTraceRecord', () => {
  it('原样带上 seq / ts / model / messages / tools / params', () => {
    const r = buildTraceRecord(base)
    expect(r.seq).toBe(8)
    expect(r.ts).toBe('2026-08-01T12:34:56.789Z')
    expect(r.model).toBe('deepseek-v4-pro')
    expect(r.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(r.tools).toEqual([{ type: 'function', function: { name: 'Read' } }])
    expect(r.params).toEqual({ stream: true, stream_options: { include_usage: true } })
  })

  it('label 缺省记为 unknown', () => {
    expect(buildTraceRecord(base).label).toBe('unknown')
  })

  it('label 给了就用给的', () => {
    expect(buildTraceRecord({ ...base, label: 'compact' }).label).toBe('compact')
  })

  it('长 messages 不被截断（截断即等于漏）', () => {
    const big = 'x'.repeat(200_000)
    const r = buildTraceRecord({ ...base, wireMessages: [{ role: 'user', content: big }] })
    expect(r.messages[0].content).toHaveLength(200_000)
  })

  it('不复制引用而是可安全序列化（落盘后仍完整）', () => {
    const r = buildTraceRecord(base)
    const round = JSON.parse(JSON.stringify(r))
    expect(round).toEqual(r)
  })
})

const rec = (seq: number) => buildTraceRecord({ ...base, seq })

describe('nextSeq', () => {
  it('目录不存在 → 1', () => {
    expect(nextSeq(path.join(tmpdir(), 'dc-trace-nope-' + Date.now()))).toBe(1)
  })

  it('空目录 → 1', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'dc-trace-'))
    expect(nextSeq(d)).toBe(1)
  })

  it('已有 req-0001/req-0007 → 8（续号，不覆盖上一次跑的轨迹）', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'dc-trace-'))
    writeFileSync(path.join(d, 'req-0001.json'), '{}')
    writeFileSync(path.join(d, 'req-0007.json'), '{}')
    expect(nextSeq(d)).toBe(8)
  })

  it('忽略不符合命名的文件', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'dc-trace-'))
    writeFileSync(path.join(d, 'req-0003.json'), '{}')
    writeFileSync(path.join(d, 'notes.txt'), 'x')
    writeFileSync(path.join(d, 'req-abc.json'), '{}')
    expect(nextSeq(d)).toBe(4)
  })

  it('seq 超过 9999 时续号不回退（不覆盖已有轨迹）', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'dc-trace-'))
    writeFileSync(path.join(d, 'req-10000.json'), '{}')
    expect(nextSeq(d)).toBe(10001)
  })
})

describe('writeTraceRecord', () => {
  it('写出 req-NNNNN.json，五位零填充，内容可解析且完整', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'dc-trace-'))
    expect(writeTraceRecord(d, rec(8))).toBe(true)
    const f = path.join(d, 'req-00008.json')
    expect(existsSync(f)).toBe(true)
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual(rec(8))
  })

  it('目录不存在时递归创建，权限 0700', () => {
    const d = path.join(mkdtempSync(path.join(tmpdir(), 'dc-trace-')), 'a', 'b')
    expect(writeTraceRecord(d, rec(1))).toBe(true)
    expect(statSync(d).mode & 0o777).toBe(0o700)
  })

  it('写盘失败时返回 false 且不抛出（诊断功能不能让主流程挂）', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'dc-trace-'))
    const d = path.join(parent, 'ro')
    mkdirSync(d)
    chmodSync(d, 0o500) // 只读目录：创建文件必失败
    let threw = false
    let ok = true
    try { ok = writeTraceRecord(d, rec(1)) } catch { threw = true }
    chmodSync(d, 0o700) // 还原，好让临时目录能被清理
    expect(threw).toBe(false)
    expect(ok).toBe(false)
  })

  it('已存在的宽松目录（0755）会被收紧到 0700 并警告', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'dc-trace-'))
    chmodSync(d, 0o755)
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(writeTraceRecord(d, rec(1))).toBe(true)
    const warned = spy.mock.calls.map(c => String(c[0])).join('')
    spy.mockRestore()
    expect(statSync(d).mode & 0o777).toBe(0o700)
    expect(warned).toContain('权限过宽')
  })
})
