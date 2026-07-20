import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeMemdirTools, assertInRoots } from '../src/services/memory/memdirTools.js'
import { allTools } from '../src/tools/index.js'

let mem: string, other: string
beforeEach(() => {
  mem = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'))
  other = fs.mkdtempSync(path.join(os.tmpdir(), 'other-'))
  fs.writeFileSync(path.join(mem, 'a.md'), '# 记忆 A\n风控\n')
  fs.mkdirSync(path.join(mem, 'logs/2026/07/13'), { recursive: true })
  fs.writeFileSync(path.join(mem, 'logs/2026/07/13/s1-x.md'), '> 查风控规则\n. Edit(a.go) ✓\n')
  fs.writeFileSync(path.join(other, 'secret.env'), 'API_KEY=sk-xxx\n')
})
afterEach(() => {
  fs.rmSync(mem, { recursive: true, force: true })
  fs.rmSync(other, { recursive: true, force: true })
})

const dreamTools = () => makeMemdirTools(mem, {
  readRoots: [mem, path.join(mem, 'logs')],
  readFiles: [path.join(other, 'allowed.jsonl')],
})
const get = (n: string) => dreamTools().find(t => t.name === n)!
const ctx: any = {}

describe('默认工具集（extract fork）不含检索工具', () => {
  it('不传 opts 时没有 MemGrep/MemGlob', () => {
    const names = makeMemdirTools(mem).map(t => t.name)
    expect(names).not.toContain('MemGrep')
    expect(names).not.toContain('MemGlob')
    expect(names).toContain('MemRead')
    expect(names).not.toContain('Read') // 通用 readTool 已被替换
  })
  it('dream 形态（传 readRoots）才追加 MemGlob/MemGrep', () => {
    const names = dreamTools().map(t => t.name)
    expect(names).toEqual(expect.arrayContaining(['MemRead', 'MemWrite', 'MemEdit', 'MemGlob', 'MemGrep']))
    expect(names).not.toContain('Read')
  })
})

describe('assertInRoots：路径断言（绝不静默失效）', () => {
  it('roots 内允许', () => {
    expect(assertInRoots([mem], [], path.join(mem, 'a.md'))).toBeNull()
    expect(assertInRoots([mem], [], path.join(mem, 'logs/2026/07/13/s1-x.md'))).toBeNull()
  })
  it('roots 外拒绝', () => {
    expect(assertInRoots([mem], [], path.join(other, 'secret.env'))).toContain('拒绝')
    expect(assertInRoots([mem], [], '/etc/passwd')).toContain('拒绝')
  })
  it('../ 绕过被归一化后拒绝', () => {
    expect(assertInRoots([mem], [], path.join(mem, '..', path.basename(other), 'secret.env'))).toContain('拒绝')
    expect(assertInRoots([mem], [], path.join(mem, 'sub/../../etc/passwd'))).toContain('拒绝')
  })
  it('前缀同名的兄弟目录不被误放行（mem-x vs mem）', () => {
    expect(assertInRoots([mem], [], mem + '-evil/x.md')).toContain('拒绝')
  })
  it('readFiles 精确白名单允许（防串项目：只放行列出的会话文件）', () => {
    const f = path.join(other, 'allowed.jsonl')
    expect(assertInRoots([mem], [f], f)).toBeNull()
    expect(assertInRoots([mem], [f], path.join(other, 'notlisted.jsonl'))).toContain('拒绝')
  })
  it('readFiles 是精确路径而非目录前缀（同目录其他会话仍被拒）', () => {
    const f = path.join(other, 'allowed.jsonl')
    expect(assertInRoots([], [f], path.join(other, 'sub', 'allowed.jsonl'))).toContain('拒绝')
  })
  it('符号链接逃逸被拒（realpath 归一化）', () => {
    const link = path.join(mem, 'escape.md')
    fs.symlinkSync(path.join(other, 'secret.env'), link)
    expect(assertInRoots([mem], [], link)).toContain('拒绝')
  })
})

describe('MemRead', () => {
  it('可读 memdir 内文件', async () => {
    const r = await get('MemRead').call({ file_path: path.join(mem, 'a.md') } as any, ctx)
    expect(String(r)).toContain('记忆 A')
  })
  it('相对路径按 memdir 解析', async () => {
    const r = await get('MemRead').call({ file_path: 'a.md' } as any, ctx)
    expect(String(r)).toContain('记忆 A')
  })
  it('拒绝读 roots 外的任意绝对路径（堵 fail-open）', async () => {
    const r = await get('MemRead').call({ file_path: path.join(other, 'secret.env') } as any, ctx)
    expect(String(r)).toContain('拒绝')
    expect(String(r)).not.toContain('sk-xxx')
  })
  it('拒绝 ../ 绕过', async () => {
    const r = await get('MemRead').call({ file_path: `../${path.basename(other)}/secret.env` } as any, ctx)
    expect(String(r)).toContain('拒绝')
    expect(String(r)).not.toContain('sk-xxx')
  })
  it('readFiles 白名单内的文件可读，白名单外的同目录文件被拒', async () => {
    const allowed = path.join(other, 'allowed.jsonl')
    fs.writeFileSync(allowed, '{"role":"user","content":"本项目会话"}\n')
    fs.writeFileSync(path.join(other, 'notlisted.jsonl'), '{"role":"user","content":"别的项目"}\n')
    const ok = await get('MemRead').call({ file_path: allowed } as any, ctx)
    expect(String(ok)).toContain('本项目会话')
    const bad = await get('MemRead').call({ file_path: path.join(other, 'notlisted.jsonl') } as any, ctx)
    expect(String(bad)).toContain('拒绝')
    expect(String(bad)).not.toContain('别的项目')
  })
  it('默认工具集（extract fork）只能读 memdir', async () => {
    const memRead = makeMemdirTools(mem).find(t => t.name === 'MemRead')!
    expect(String(await memRead.call({ file_path: path.join(mem, 'a.md') } as any, ctx))).toContain('记忆 A')
    const r = await memRead.call({ file_path: path.join(other, 'secret.env') } as any, ctx)
    expect(String(r)).toContain('拒绝')
    expect(String(r)).not.toContain('sk-xxx')
  })
  it('文件不存在 → 错误串（不抛）', async () => {
    expect(String(await get('MemRead').call({ file_path: 'nope.md' } as any, ctx))).toMatch(/错误|不存在/)
  })
})

describe('MemRead 会话 transcript 回声过滤（不许绕开 MemGrep 已有的防回声放大）', () => {
  it('.jsonl 过滤 role:system 行、单行 <system-reminder> 块、跨行 <system-reminder> 块，正文保留，并附可见跳过提示', async () => {
    const sess = path.join(other, 'sess1.jsonl')
    fs.writeFileSync(sess,
      '{"role":"user","content":"你好"}\n' +
      '{"role":"system","content":"系统提示 隐藏内容"}\n' +
      '<system-reminder>单行回声 已存记忆</system-reminder>\n' +
      '<system-reminder>\n跨行回声 已存记忆\n</system-reminder>\n' +
      '{"role":"assistant","content":"收到"}\n'
    )
    const tools = makeMemdirTools(mem, { readRoots: [mem], readFiles: [sess] })
    const r = String(await tools.find(t => t.name === 'MemRead')!.call({ file_path: sess } as any, ctx))
    expect(r).not.toContain('隐藏内容')
    expect(r).not.toContain('单行回声')
    expect(r).not.toContain('跨行回声')
    expect(r).toContain('你好')
    expect(r).toContain('收到')
    expect(r).toMatch(/已跳过 \d+ 行/)
  })
  it('普通 .md 记忆文件即使含 <system-reminder> 字样也不过滤（不是 transcript）', async () => {
    fs.writeFileSync(path.join(mem, 'note-with-tag.md'), '记录：曾见过 <system-reminder>不是真实块</system-reminder> 字样\n')
    const r = String(await get('MemRead').call({ file_path: 'note-with-tag.md' } as any, ctx))
    expect(r).toContain('<system-reminder>不是真实块</system-reminder>')
  })
})

describe('MemGlob', () => {
  it('能发现 logs/ 下的日志文件', async () => {
    const r = await get('MemGlob').call({ pattern: 'logs/**/*.md' } as any, ctx)
    expect(String(r)).toContain('s1-x.md')
  })
  it('不列出 roots 外的文件', async () => {
    const r = await get('MemGlob').call({ pattern: '**/*.env' } as any, ctx)
    expect(String(r)).not.toContain('secret.env')
  })
  it('结果不重复（logs 既在 memdir 内又单列为 root）', async () => {
    const r = String(await get('MemGlob').call({ pattern: '**/*.md' } as any, ctx))
    const lines = r.split('\n').filter(l => l.includes('s1-x.md'))
    expect(lines.length).toBe(1)
  })
})

describe('MemGrep', () => {
  it('能检索 roots 内内容', async () => {
    const r = await get('MemGrep').call({ pattern: '风控' } as any, ctx)
    expect(String(r)).toContain('风控')
    expect(String(r)).toContain('a.md')
  })
  it('不检索 roots 外的文件（不泄密）', async () => {
    fs.writeFileSync(path.join(other, 'leak.md'), 'API_KEY=sk-xxx 风控\n')
    const r = String(await get('MemGrep').call({ pattern: '风控' } as any, ctx))
    expect(r).not.toContain('sk-xxx')
  })
  it('path 参数越界被拒', async () => {
    const r = await get('MemGrep').call({ pattern: '.', path: other } as any, ctx)
    expect(String(r)).toContain('拒绝')
  })
  it('path 限定合法子目录时仍能命中（不得误拒）', async () => {
    const r = String(await get('MemGrep').call({ pattern: '风控', path: path.join(mem, 'logs') } as any, ctx))
    expect(r).toContain('s1-x.md')
    expect(r).not.toContain('a.md') // 限定生效：memdir 顶层的命中不出现
  })
  it('per-line 截断 ≤300 字符（.jsonl 单行 p99 达 11k）', async () => {
    fs.writeFileSync(path.join(mem, 'big.md'), 'X'.repeat(5000) + ' 风控\n')
    const r = await get('MemGrep').call({ pattern: '风控' } as any, ctx)
    for (const line of String(r).split('\n')) expect(line.length).toBeLessThanOrEqual(400)
  })
  it('跳过 <system-reminder> 块与 role:system（防回声放大）', async () => {
    fs.writeFileSync(path.join(mem, 'echo.md'),
      '{"role":"system","content":"风控 系统提示"}\n<system-reminder>风控 记忆回声</system-reminder>\n正文 风控\n')
    const r = await get('MemGrep').call({ pattern: '风控' } as any, ctx)
    expect(String(r)).not.toContain('系统提示')
    expect(String(r)).not.toContain('记忆回声')
    expect(String(r)).toContain('正文')
  })
  it('跨行 <system-reminder> 块整体跳过', async () => {
    fs.writeFileSync(path.join(mem, 'echo2.md'),
      '<system-reminder>\n风控 块内回声\n</system-reminder>\n风控 块外正文\n')
    const r = String(await get('MemGrep').call({ pattern: '风控' } as any, ctx))
    expect(r).not.toContain('块内回声')
    expect(r).toContain('块外正文')
  })
  it('命中数超上限 → 截断并提示更窄的词', async () => {
    fs.writeFileSync(path.join(mem, 'many.md'), Array.from({ length: 200 }, (_, i) => `风控 ${i}`).join('\n'))
    const r = String(await get('MemGrep').call({ pattern: '风控' } as any, ctx))
    expect(r).toMatch(/上限|更窄/)
    expect(r.split('\n').filter(l => /:\d+:/.test(l)).length).toBeLessThanOrEqual(50)
  })
  it('无效正则 → 错误串（不抛）', async () => {
    expect(String(await get('MemGrep').call({ pattern: '[' } as any, ctx))).toMatch(/错误|无效/)
  })
})

describe('不变量：记忆工具不外泄进主工具池', () => {
  it('allTools 不含任何 Mem* 工具', () => {
    const names = allTools.map(t => t.name)
    for (const n of ['MemRead', 'MemGrep', 'MemGlob', 'MemWrite', 'MemEdit']) expect(names).not.toContain(n)
  })
})
