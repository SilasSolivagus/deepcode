// Task 9：dream prompt 换成 CC 四阶段 + 工具集接线（日志/transcript 检索 + CLAUDE.md 对账）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { buildConsolidationPrompt, runAutoDream } from '../src/services/memory/autoDream.js'
import { DEFAULT_MEMORY_CONFIG } from '../src/memdir/memoryConfig.js'

const p = () => buildConsolidationPrompt({
  sessionCount: 7,
  sessionFiles: ['/s/a.jsonl', '/s/b.jsonl'],
  memdir: '/mem',
  logsDir: '/mem/logs',
})

describe('dream prompt：CC 四阶段', () => {
  it('四个阶段齐全', () => {
    const t = p()
    for (const phase of ['Orient', 'Gather', 'Consolidate', 'Prune']) expect(t).toContain(phase)
  })

  it('会话数不再恒为 0', () => {
    expect(p()).toContain('7')
  })

  it('注入本项目会话文件列表（不含别项目）', () => {
    const t = p()
    expect(t).toContain('/s/a.jsonl')
    expect(t).toContain('/s/b.jsonl')
  })

  it('说明活动日志的路径与行前缀编码', () => {
    const t = p()
    expect(t).toContain('/mem/logs')
    expect(t).toContain('YYYY/MM/DD')
    expect(t).toMatch(/`>`.*用户/)
    expect(t).toMatch(/`<`.*助手/)
  })

  it('含「记忆 vs CLAUDE.md 对账」段，且明令 dream 期间不得修改 CLAUDE.md', () => {
    const t = p()
    expect(t).toContain('CLAUDE.md')
    expect(t).toContain('不要在 dream 期间修改 CLAUDE.md')
  })

  it('给出 transcript 窄搜指引与不可信数据边界', () => {
    const t = p()
    expect(t).toContain('MemGrep')
    expect(t).toContain('背景参考')
  })

  it('MEMORY.md 索引上限', () => {
    const t = p()
    expect(t).toContain('200')
    expect(t).toContain('25')
  })

  it('列出 CLAUDE.md 路径并说明用 MemRead 读（fork 的系统提示里没有它）', () => {
    const t = buildConsolidationPrompt({
      sessionCount: 1, sessionFiles: [], memdir: '/mem', logsDir: '/mem/logs',
      claudeMdFiles: ['/proj/CLAUDE.md'],
    })
    expect(t).toContain('/proj/CLAUDE.md')
    expect(t).toContain('MemRead')
    expect(t).not.toContain('已加载进你的系统提示')
  })

  it('会话列表为空时不留空洞', () => {
    const t = buildConsolidationPrompt({ sessionCount: 0, sessionFiles: [], memdir: '/mem', logsDir: '/mem/logs' })
    expect(t).toContain('（无）')
  })
})

describe('runAutoDream：工具集接线', () => {
  let md: string, sd: string, cwd: string
  beforeEach(() => {
    md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-t9m-'))
    sd = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-t9s-'))
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-t9c-'))
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# 项目规则\n- 用 pnpm\n')
    fs.mkdirSync(path.join(md, 'logs', '2026', '07', '13'), { recursive: true })
    fs.writeFileSync(path.join(md, 'logs', '2026', '07', '13', 's1-修日志.md'), '> 修一下日志\n< 已修\n')
  })
  afterEach(() => {
    for (const d of [md, sd, cwd]) fs.rmSync(d, { recursive: true, force: true })
  })

  const run = async (sessionFiles: string[]) => {
    let captured: any = null
    const runSub = vi.fn(async (opts: any) => { captured = opts; return 'done' })
    await runAutoDream({
      client: {} as any, model: 'm', memdir: md, sessionsDir: sd,
      currentSessionFile: path.join(sd, 'cur.jsonl'), projectKey: 'proj',
      cfg: DEFAULT_MEMORY_CONFIG.dream,
      ctx: { signal: new AbortController().signal, cwd: () => cwd } as any,
      now: Date.now(), lastScanAt: 0, runSubagent: runSub,
      gate: () => ({ pass: true, n: sessionFiles.length, sessionFiles }),
    })
    expect(runSub).toHaveBeenCalled()
    return captured
  }

  it('dream 形态拿到 MemGlob/MemGrep（extract fork 拿不到）', async () => {
    const sess = path.join(sd, 'a.jsonl')
    fs.writeFileSync(sess, '{"role":"user","content":"hi"}\n')
    const o = await run([sess])
    const names = o.tools.map((t: any) => t.name)
    expect(names).toContain('MemGlob')
    expect(names).toContain('MemGrep')
    expect(names).toEqual(expect.arrayContaining(['MemRead', 'MemWrite', 'MemEdit']))
  })

  it('工具能读到本项目会话 transcript（在 readFiles 白名单里），读不到别项目的会话', async () => {
    const mine = path.join(sd, 'mine.jsonl')
    const other = path.join(sd, 'other.jsonl')
    fs.writeFileSync(mine, '{"role":"user","content":"构建失败 ENOENT"}\n')
    fs.writeFileSync(other, '{"role":"user","content":"别项目的秘密"}\n')
    const o = await run([mine])
    const memRead = o.tools.find((t: any) => t.name === 'MemRead')
    expect(await memRead.call({ file_path: mine })).toContain('构建失败')
    expect(await memRead.call({ file_path: other })).toMatch(/不在本次允许的读取范围内/)
  })

  it('CLAUDE.md 在可读白名单里（否则 Phase 4 对账做不到）', async () => {
    const o = await run([])
    const memRead = o.tools.find((t: any) => t.name === 'MemRead')
    expect(await memRead.call({ file_path: path.join(cwd, 'CLAUDE.md') })).toContain('用 pnpm')
  })

  it('MemGlob 能命中活动日志', async () => {
    const o = await run([])
    const memGlob = o.tools.find((t: any) => t.name === 'MemGlob')
    const out = await memGlob.call({ pattern: 'logs/**/*.md' })
    expect(out).toContain('s1-修日志.md')
  })
})
