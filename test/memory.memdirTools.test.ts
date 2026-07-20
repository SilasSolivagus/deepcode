import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeMemdirTools, assertInMemdir, stampGlobalMeta } from '../src/services/memory/memdirTools.js'
import { WRITE_LOCK } from '../src/services/memory/writeLock.js'

test('assertInMemdir 拦越界', () => {
  const md = '/home/u/.deepcode/projects/k/memory'
  expect(assertInMemdir(md, path.join(md, 'a.md'))).toBe(null)
  expect(assertInMemdir(md, path.join(md, 'sub/a.md'))).toBe(null)
  expect(assertInMemdir(md, '/home/u/.ssh/id_rsa')).not.toBe(null)
  expect(assertInMemdir(md, path.join(md, '../../../etc/passwd'))).not.toBe(null)
})

describe('makeMemdirTools 写工具', () => {
  let md: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-mt-')) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }) })
  const ctx: any = { cwd: () => md, fileState: new Map(), signal: new AbortController().signal }

  test('MemWrite 落 memdir 内成功', async () => {
    const tools = makeMemdirTools(md)
    const w = tools.find(t => t.name === 'MemWrite')!
    const r = await w.call({ file_path: 'note.md', content: 'hi' }, ctx)
    expect(r).toContain('已写入')
    expect(fs.readFileSync(path.join(md, 'note.md'), 'utf8')).toBe('hi')
  })
  test('MemWrite 越界被拒、不写盘', async () => {
    const tools = makeMemdirTools(md)
    const w = tools.find(t => t.name === 'MemWrite')!
    const out = '/tmp/evil-' + path.basename(md) + '.txt'
    const r = await w.call({ file_path: out, content: 'x' }, ctx)
    expect(r).toMatch(/拒绝|越界|memory/)
    expect(fs.existsSync(out)).toBe(false)
  })
  test('含 MemRead（通用 Read 已被断言版替换）', () => {
    const names = makeMemdirTools(md).map(t => t.name)
    expect(names).toContain('MemRead')
    expect(names).not.toContain('Read')
  })
})

describe('assertInMemdir symlink 逃逸（写围栏须解 symlink，不能只 path.resolve）', () => {
  let md: string
  let outside: string
  beforeEach(() => {
    md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-mt-sym-'))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-mt-out-'))
  })
  afterEach(() => {
    fs.rmSync(md, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })
  const ctx: any = { cwd: () => md, fileState: new Map(), signal: new AbortController().signal }

  test('memdir 内软链指向 memdir 外文件 → MemWrite 拒、外部文件未被改写', async () => {
    const target = path.join(outside, '.env')
    fs.writeFileSync(target, 'API_KEY=secret\n')
    fs.symlinkSync(target, path.join(md, 'envlink.md'))
    const w = makeMemdirTools(md).find(t => t.name === 'MemWrite')!
    const r = await w.call({ file_path: 'envlink.md', content: 'pwned' }, ctx)
    expect(r).toMatch(/拒绝|越界|memory/)
    expect(fs.readFileSync(target, 'utf8')).toBe('API_KEY=secret\n')
  })

  test('memdir 内软链指向 memdir 外文件 → MemEdit 拒、外部文件未被改写', async () => {
    const target = path.join(outside, '.env')
    fs.writeFileSync(target, 'API_KEY=secret\n')
    fs.symlinkSync(target, path.join(md, 'envlink.md'))
    const e = makeMemdirTools(md).find(t => t.name === 'MemEdit')!
    const r = await e.call({ file_path: 'envlink.md', old_string: 'secret', new_string: 'pwned' }, ctx)
    expect(r).toMatch(/拒绝|越界|memory/)
    expect(fs.readFileSync(target, 'utf8')).toBe('API_KEY=secret\n')
  })

  test('memdir 内软链指向 memdir 外目录 → 该目录下的新文件写入被拒', async () => {
    fs.symlinkSync(outside, path.join(md, 'dirlink'))
    const w = makeMemdirTools(md).find(t => t.name === 'MemWrite')!
    const r = await w.call({ file_path: 'dirlink/newfile.md', content: 'pwned' }, ctx)
    expect(r).toMatch(/拒绝|越界|memory/)
    expect(fs.existsSync(path.join(outside, 'newfile.md'))).toBe(false)
  })

  test('反向：尚不存在的新文件（含多层新目录）不被误拒', async () => {
    const w = makeMemdirTools(md).find(t => t.name === 'MemWrite')!
    const r = await w.call({ file_path: 'a/b/c.md', content: 'hi' }, ctx)
    expect(r).toContain('已写入')
    expect(fs.readFileSync(path.join(md, 'a/b/c.md'), 'utf8')).toBe('hi')
  })

  test('反向：正常顶层记忆写入/编辑仍放行', async () => {
    const w = makeMemdirTools(md).find(t => t.name === 'MemWrite')!
    expect(await w.call({ file_path: 'ok.md', content: 'v1' }, ctx)).toContain('已写入')
    const e = makeMemdirTools(md).find(t => t.name === 'MemEdit')!
    const r = await e.call({ file_path: 'ok.md', old_string: 'v1', new_string: 'v2' }, ctx)
    expect(r).toContain('已编辑')
    expect(fs.readFileSync(path.join(md, 'ok.md'), 'utf8')).toBe('v2')
  })
})

describe('makeMemdirTools MemEdit', () => {
  let md: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-me-')) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }) })
  const ctx: any = { cwd: () => md, fileState: new Map(), signal: new AbortController().signal }

  test('MemEdit 正常替换 memdir 内文件', async () => {
    fs.writeFileSync(path.join(md, 'n.md'), 'A B C')
    const e = makeMemdirTools(md).find(t => t.name === 'MemEdit')!
    const r = await e.call({ file_path: 'n.md', old_string: 'B', new_string: 'X' }, ctx)
    expect(r).toContain('已编辑')
    expect(fs.readFileSync(path.join(md, 'n.md'), 'utf8')).toBe('A X C')
  })
  test('MemEdit 越界被拒、不改盘', async () => {
    const other = path.join(os.tmpdir(), 'dc-me-evil.md'); fs.writeFileSync(other, 'Z')
    const e = makeMemdirTools(md).find(t => t.name === 'MemEdit')!
    const r = await e.call({ file_path: other, old_string: 'Z', new_string: 'Q' }, ctx)
    expect(r).toMatch(/拒绝|越界|memory/)
    expect(fs.readFileSync(other, 'utf8')).toBe('Z')
    fs.rmSync(other, { force: true })
  })
  test('MemEdit 文件不存在 → 错误串', async () => {
    const e = makeMemdirTools(md).find(t => t.name === 'MemEdit')!
    expect(await e.call({ file_path: 'nope.md', old_string: 'x', new_string: 'y' }, ctx)).toMatch(/不存在/)
  })
  test('MemEdit old_string 未匹配 → 错误串', async () => {
    fs.writeFileSync(path.join(md, 'n.md'), 'AAA')
    const e = makeMemdirTools(md).find(t => t.name === 'MemEdit')!
    expect(await e.call({ file_path: 'n.md', old_string: 'ZZZ', new_string: 'y' }, ctx)).toMatch(/未匹配/)
  })
  test('MemEdit old_string 多匹配 → 报错含多处/唯一、不改文件', async () => {
    fs.writeFileSync(path.join(md, 'n.md'), 'A B A B A')
    const e = makeMemdirTools(md).find(t => t.name === 'MemEdit')!
    const r = await e.call({ file_path: 'n.md', old_string: 'A', new_string: 'X' }, ctx)
    expect(r).toMatch(/匹配到 \d+ 处|请提供更多上下文/)
    expect(fs.readFileSync(path.join(md, 'n.md'), 'utf8')).toBe('A B A B A')
  })
  test('MemEdit old_string 为空串 → 错误串、不改文件', async () => {
    fs.writeFileSync(path.join(md, 'n.md'), 'hello')
    const e = makeMemdirTools(md).find(t => t.name === 'MemEdit')!
    const r = await e.call({ file_path: 'n.md', old_string: '', new_string: 'X' }, ctx)
    expect(r).toMatch(/不能为空/)
    expect(fs.readFileSync(path.join(md, 'n.md'), 'utf8')).toBe('hello')
  })
})

describe('scope 参数：双抽屉写入', () => {
  let proj: string, glob: string
  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-scope-'))
    proj = path.join(tmp, 'proj'); glob = path.join(tmp, 'glob')
    fs.mkdirSync(proj, { recursive: true }); fs.mkdirSync(glob, { recursive: true })
  })

  const tools = () => makeMemdirTools(proj, { globalMemdir: glob, originKey: '-repo-a' })
  const write = () => tools().find(t => t.name === 'MemWrite')!
  const edit = () => tools().find(t => t.name === 'MemEdit')!
  const ctx: any = { cwd: () => proj, fileState: new Map(), signal: new AbortController().signal }

  test('默认（不填 scope）写项目抽屉', async () => {
    await write().call({ file_path: 'a.md', content: 'x' } as any, ctx)
    expect(fs.existsSync(path.join(proj, 'a.md'))).toBe(true)
    expect(fs.existsSync(path.join(glob, 'a.md'))).toBe(false)
  })

  test("scope:'global' 写全局抽屉", async () => {
    await write().call({ file_path: 'b.md', content: 'x', scope: 'global' } as any, ctx)
    expect(fs.existsSync(path.join(glob, 'b.md'))).toBe(true)
    expect(fs.existsSync(path.join(proj, 'b.md'))).toBe(false)
  })

  test('未提供 globalMemdir 时，scope:global 被拒（不静默落项目抽屉）', async () => {
    const t = makeMemdirTools(proj).find(x => x.name === 'MemWrite')!
    const out = await t.call({ file_path: 'c.md', content: 'x', scope: 'global' } as any, ctx)
    expect(out).toContain('不允许写入全局记忆')
    expect(fs.existsSync(path.join(proj, 'c.md'))).toBe(false)
  })

  test('全局写自动盖 origin/created 溯源戳', async () => {
    await write().call({ file_path: 'd.md', content: '---\nname: d\ntype: user\n---\n正文', scope: 'global' } as any, ctx)
    const body = fs.readFileSync(path.join(glob, 'd.md'), 'utf8')
    expect(body).toContain('origin: -repo-a')
    expect(body).toMatch(/created: \d{4}-\d{2}-\d{2}/)
    expect(body).toContain('正文')
  })

  test('项目写不盖 origin 戳', async () => {
    await write().call({ file_path: 'e.md', content: '---\nname: e\n---\n正文' } as any, ctx)
    expect(fs.readFileSync(path.join(proj, 'e.md'), 'utf8')).not.toContain('origin:')
  })

  test('MemEdit 同样按 scope 选抽屉', async () => {
    fs.writeFileSync(path.join(glob, 'f.md'), 'hello world')
    await edit().call({ file_path: 'f.md', old_string: 'world', new_string: 'deepcode', scope: 'global' } as any, ctx)
    expect(fs.readFileSync(path.join(glob, 'f.md'), 'utf8')).toBe('hello deepcode')
  })

  test('全局抽屉的越界写被拦截', async () => {
    const out = await write().call({ file_path: '../escape.md', content: 'x', scope: 'global' } as any, ctx)
    expect(out).toContain('拒绝')
  })

  test('抢不到写锁时放弃本次写，不覆盖对方（fail-safe，且不报错）', async () => {
    fs.writeFileSync(path.join(glob, '.write-lock'), String(process.pid)) // 模拟别的会话持锁
    fs.writeFileSync(path.join(glob, 'g.md'), '对方写的内容')
    const out = await write().call({ file_path: 'g.md', content: '我写的内容', scope: 'global' } as any, ctx)
    expect(out).toContain('跳过')
    expect(fs.readFileSync(path.join(glob, 'g.md'), 'utf8')).toBe('对方写的内容')
  })

  test('写完锁被释放', async () => {
    await write().call({ file_path: 'h.md', content: 'x', scope: 'global' } as any, ctx)
    expect(fs.existsSync(path.join(glob, '.write-lock'))).toBe(false)
  })

  // I1：schema 层默认值/非法值是最后一道防线（生产路径经 tool.inputSchema.safeParse，不是直接 .call）。
  test('schema 层：scope 缺失 → project；非法值一律拒收（MemWrite）', () => {
    const w = write()
    expect((w.inputSchema.safeParse({ file_path: 'a.md', content: 'x' }) as any).data.scope).toBe('project')
    for (const bad of ['GLOBAL', 'Global', '', null, 42, ['global']])
      expect(w.inputSchema.safeParse({ file_path: 'a.md', content: 'x', scope: bad }).success).toBe(false)
  })
  test('schema 层：scope 缺失 → project；非法值一律拒收（MemEdit）', () => {
    const e = edit()
    expect((e.inputSchema.safeParse({ file_path: 'a.md', old_string: 'a', new_string: 'b' }) as any).data.scope).toBe('project')
    for (const bad of ['GLOBAL', 'Global', '', null, 42, ['global']])
      expect(e.inputSchema.safeParse({ file_path: 'a.md', old_string: 'a', new_string: 'b', scope: bad }).success).toBe(false)
  })

  // I2：guard() 分支——用 patch 锁文件读来忠实模拟「陈旧锁被两进程同时夺取」时锁易主的微秒级窗口，不需要多进程。
  test('guard() 校验（MemWrite）：落盘前发现锁已易主 → 弃写，不覆盖对方', async () => {
    fs.writeFileSync(path.join(glob, 'g.md'), '对方写的内容')
    const lockPath = path.join(glob, WRITE_LOCK)
    const realRead = fs.readFileSync
    ;(fs as any).readFileSync = (p: any, ...r: any[]) =>
      String(p) === lockPath ? '99999:someone-elses-token' : (realRead as any)(p, ...r)
    try {
      const out = await write().call({ file_path: 'g.md', content: '我写的', scope: 'global' } as any, ctx)
      expect(out).toContain('跳过')
      expect(realRead(path.join(glob, 'g.md'), 'utf8')).toBe('对方写的内容')
    } finally { (fs as any).readFileSync = realRead }
  })
  test('guard() 校验（MemEdit）：落盘前发现锁已易主 → 弃写，不覆盖对方', async () => {
    fs.writeFileSync(path.join(glob, 'g2.md'), '对方写的内容')
    const lockPath = path.join(glob, WRITE_LOCK)
    const realRead = fs.readFileSync
    ;(fs as any).readFileSync = (p: any, ...r: any[]) =>
      String(p) === lockPath ? '99999:someone-elses-token' : (realRead as any)(p, ...r)
    try {
      const out = await edit().call({ file_path: 'g2.md', old_string: '对方', new_string: '我', scope: 'global' } as any, ctx)
      expect(out).toContain('跳过')
      expect(realRead(path.join(glob, 'g2.md'), 'utf8')).toBe('对方写的内容')
    } finally { (fs as any).readFileSync = realRead }
  })

  // M1：MemWrite 是覆盖写，模型重写已存在的全局记忆时若不带旧 frontmatter，created 不该被重置成今天。
  test('全局覆盖写：旧文件已有 created 时保留，不重置成今天（M1）', async () => {
    const p = path.join(glob, 'persist.md')
    fs.writeFileSync(p, '---\norigin: -repo-a\ncreated: 2020-01-01\nname: old\n---\n旧正文')
    await write().call({ file_path: 'persist.md', content: '---\nname: new\n---\n新正文', scope: 'global' } as any, ctx)
    const body = fs.readFileSync(p, 'utf8')
    expect(body).toContain('created: 2020-01-01')
    expect((body.match(/created:/g) ?? []).length).toBe(1)
    expect(body).toContain('新正文')
  })
})

describe('stampGlobalMeta', () => {
  test('往已有 frontmatter 里插 origin/created', () => {
    const out = stampGlobalMeta('---\nname: a\ntype: user\n---\n正文', '-repo-a', '2026-07-14')
    expect(out).toBe('---\nname: a\ntype: user\norigin: -repo-a\ncreated: 2026-07-14\n---\n正文')
  })
  test('无 frontmatter 时补一个', () => {
    const out = stampGlobalMeta('裸正文', '-repo-a', '2026-07-14')
    expect(out).toBe('---\norigin: -repo-a\ncreated: 2026-07-14\n---\n裸正文')
  })
  test('已有 origin/created 时覆盖而非重复', () => {
    const out = stampGlobalMeta('---\norigin: -old\ncreated: 2020-01-01\nname: a\n---\n正文', '-repo-a', '2026-07-14')
    expect(out.match(/origin:/g)?.length).toBe(1)
    expect(out).toContain('origin: -repo-a')
    expect(out).toContain('created: 2020-01-01') // created 是首次写入时间，不覆盖
  })

  // I3：strip 正则锚到行首顶层，不误删 block scalar 正文/嵌套 key 下缩进的 origin:/created: 行。
  test('不误删 block scalar 正文里缩进的 origin: 行', () => {
    const out = stampGlobalMeta('---\ndesc: |\n  origin: 这是正文一部分\n  第二行\nname: a\n---\n正文', '-repo-a', '2026-07-14')
    expect(out).toContain('origin: 这是正文一部分')
    expect(out).toContain('第二行')
    expect(out.match(/^origin\s*:/m)?.length).toBe(1) // 顶层 origin 仍只有一条（代码盖的那条）
  })
  test('不误删嵌套 key 下缩进的 origin: 行', () => {
    const out = stampGlobalMeta('---\nmeta:\n  origin: nested\nname: a\n---\n正文', '-repo-a', '2026-07-14')
    expect(out).toContain('origin: nested')
    expect(out).toContain('meta:')
    expect(out).toContain('name: a')
  })
  test('created 探测同样锚到顶层：嵌套/缩进的 created: 不算已存在，仍补上真正的顶层 created', () => {
    const out = stampGlobalMeta('---\nmeta:\n  created: nested-value\nname: a\n---\n正文', '-repo-a', '2026-07-14')
    expect(out).toContain('created: nested-value') // 嵌套行原样保留
    expect(out).toMatch(/\ncreated: 2026-07-14/) // 顶层补上真正的 created
  })
  test('existingCreated 参数：传入时覆盖写用旧值而非 nowIso', () => {
    const out = stampGlobalMeta('---\nname: a\n---\n正文', '-repo-a', '2026-07-14', '2020-01-01')
    expect(out).toContain('created: 2020-01-01')
    expect(out).not.toContain('2026-07-14')
  })
})
