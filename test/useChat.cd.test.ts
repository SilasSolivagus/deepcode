// test/useChat.cd.test.ts —— Task5：/cd 迁移会话主工作目录
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveCdTarget, createChatCore } from '../src/tui/useChat.js'
import { memdirFor } from '../src/memdir/paths.js'

// 终审 fix：/cd 迁移目录后须重建 memory extractor（否则每轮提取继续误写旧目录 memdir）。
// spy 真实实现（不替换行为），只用来断言构造调用次数与参数。
vi.mock('../src/services/memory/extractMemories.js', async orig => {
  const actual = await orig() as any
  return { ...actual, createMemoryExtractor: vi.fn(actual.createMemoryExtractor) }
})
import * as extractMod from '../src/services/memory/extractMemories.js'

describe('resolveCdTarget', () => {
  it('存在的目录 → ok + 绝对路径', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-cd-'))
    const r = resolveCdTarget('/tmp', dir)
    expect(r).toEqual({ ok: true, path: path.resolve(dir) })
  })
  it('相对路径按 cwd 解析', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'dc-cd-'))
    const sub = path.join(base, 'sub')
    mkdirSync(sub)
    const r = resolveCdTarget(base, 'sub')
    expect(r).toEqual({ ok: true, path: sub })
  })
  it('~ 展开到 home', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dc-home-'))
    const r = resolveCdTarget('/tmp', '~', home)
    expect(r).toEqual({ ok: true, path: home })
  })
  it('不存在 → error', () => {
    const r = resolveCdTarget('/tmp', '/definitely/no/such/dir/xyz')
    expect(r.ok).toBe(false)
  })
  it('是文件不是目录 → error', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-cd-'))
    const f = path.join(dir, 'file.txt'); writeFileSync(f, 'x')
    const r = resolveCdTarget('/tmp', f)
    expect(r.ok).toBe(false)
  })
})

describe('/cd 集成', () => {
  it('迁移到新目录后 getCwd 更新', async () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'dc-sess-'))
    const target = mkdtempSync(path.join(tmpdir(), 'dc-target-'))
    writeFileSync(path.join(target, 'DEEPCODE.md'), '# 目标目录记忆TARGETMEM')
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    await core.send(`/cd ${target}`)
    expect(core.getCwd()).toBe(path.resolve(target))
    core.dispose()
  })
  it('非法路径不改动 cwd', async () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'dc-sess-'))
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    await core.send('/cd /no/such/dir/xyz')
    expect(core.getCwd()).toBe('/tmp')
    core.dispose()
  })

  it('迁移到新目录后重建 memory extractor，指向新目录 memdir（终审 fix：此前遗漏，提取误写旧目录）', async () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'dc-sess-'))
    const target = mkdtempSync(path.join(tmpdir(), 'dc-target-'))
    const spy = extractMod.createMemoryExtractor as unknown as ReturnType<typeof vi.fn>
    const callsBefore = spy.mock.calls.length // createChatCore 构造时已调用一次

    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    expect(spy.mock.calls.length).toBe(callsBefore + 1) // 构造本身也算一次，先记录基线

    const baseline = spy.mock.calls.length
    await core.send(`/cd ${target}`)

    expect(spy.mock.calls.length).toBe(baseline + 1) // /cd 后必须重建一次
    const lastArgs = spy.mock.calls.at(-1)?.[0]
    expect(lastArgs.memdir).toBe(memdirFor(path.resolve(target)))
    core.dispose()
  })

  it('非法路径不重建 extractor', async () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'dc-sess-'))
    const spy = extractMod.createMemoryExtractor as unknown as ReturnType<typeof vi.fn>

    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    const baseline = spy.mock.calls.length
    await core.send('/cd /no/such/dir/xyz')

    expect(spy.mock.calls.length).toBe(baseline) // 非法路径分支提前 return，不应重建
    core.dispose()
  })
})
