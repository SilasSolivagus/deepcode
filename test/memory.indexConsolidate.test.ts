import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runIndexConsolidation } from '../src/services/memory/indexConsolidate.js'
import { parseMemoryConfig, DEFAULT_MEMORY_CONFIG } from '../src/memdir/memoryConfig.js'

let dir: string
const write = (d: string, n: string, body: string) =>
  fs.writeFileSync(path.join(d, n), `---\ndescription: ${n}\ntype: user\n---\n${body}\n`)
const deps = (over: any) => ({ client: {} as any, model: 'm', signal: new AbortController().signal, ...over })

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idxcon-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('runIndexConsolidation', () => {
  it('把记忆归纳写入 .index.md，源文件不动', async () => {
    write(dir, 'a.md', 'alpha')
    const before = fs.readFileSync(path.join(dir, 'a.md'), 'utf8')
    await runIndexConsolidation(deps({ memdir: dir, generate: async () => '## 主题\n- project:a.md: alpha' }))
    expect(fs.readFileSync(path.join(dir, '.index.md'), 'utf8')).toContain('project:a.md')
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe(before) // 源文件一字不改
  })

  it('已有 .index.md 且无记忆更新 → 跳过重算（不再调用 generate，消除无脑重算+全局跨项目双花）', async () => {
    write(dir, 'a.md', 'alpha')
    let calls = 0
    const gen = async () => { calls++; return '## 主题\n- project:a.md: alpha' }
    await runIndexConsolidation(deps({ memdir: dir, generate: gen })) // 首次：无 .index.md → 生成
    expect(calls).toBe(1)
    // .index.md 比所有记忆新（模拟刚归纳完，没有新记忆）
    const future = new Date(Date.now() + 60_000)
    fs.utimesSync(path.join(dir, '.index.md'), future, future)
    await runIndexConsolidation(deps({ memdir: dir, generate: gen })) // 无变化 → 应跳过
    expect(calls).toBe(1) // 没有再调用 generate
  })

  it('有比 .index.md 更新的记忆 → 重算', async () => {
    write(dir, 'a.md', 'alpha')
    fs.writeFileSync(path.join(dir, '.index.md'), '## 旧索引')
    const past = new Date(Date.now() - 3600_000)
    fs.utimesSync(path.join(dir, '.index.md'), past, past) // 索引旧，a.md（now）更新 → 应重算
    let calls = 0
    const gen = async () => { calls++; return '## 主题\n- project:a.md: alpha' }
    await runIndexConsolidation(deps({ memdir: dir, generate: gen }))
    expect(calls).toBe(1)
  })

  it('generate 抛错时不写 .index.md（fail-safe，不留半成品）', async () => {
    write(dir, 'a.md', 'alpha')
    await runIndexConsolidation(deps({ memdir: dir, generate: async () => { throw new Error('boom') } }))
    expect(fs.existsSync(path.join(dir, '.index.md'))).toBe(false)
  })

  it('无记忆时不写', async () => {
    await runIndexConsolidation(deps({ memdir: dir, generate: async () => 'x' }))
    expect(fs.existsSync(path.join(dir, '.index.md'))).toBe(false)
  })

  it('走 client 时上报归一后用量（计入成本）', async () => {
    write(dir, 'a.md', 'alpha')
    const client = { chat: { completions: { create: async () => ({
      choices: [{ message: { content: '## 主题\n- project:a.md: alpha' } }],
      usage: { prompt_tokens: 800, completion_tokens: 120, prompt_cache_hit_tokens: 200 },
    }) } } }
    const seen: any[] = []
    // 不传 generate → 走 defaultGenerate 的真实 client 路径
    await runIndexConsolidation(deps({ memdir: dir, client, onUsage: (u: any, m: any) => seen.push({ u, m }) }))
    expect(seen).toHaveLength(1)
    expect(seen[0].m).toBe('m')
    expect(seen[0].u).toEqual({ prompt_tokens: 800, completion_tokens: 120, prompt_cache_hit_tokens: 200 })
  })

  it('大 memdir 下拼给 generate 的 prompt 有界，不会随正文总量线性膨胀', async () => {
    // 30 个文件、每个正文 5000 字符 → 原始正文总量 150000 字符，远超 TOTAL_BODIES_MAX(40000)
    const FILE_COUNT = 30
    const RAW_BODY_LEN = 5000
    for (let i = 0; i < FILE_COUNT; i++) write(dir, `f${i}.md`, 'x'.repeat(RAW_BODY_LEN))
    let capturedPrompt = ''
    await runIndexConsolidation(deps({
      memdir: dir,
      generate: async (p: string) => { capturedPrompt = p; return '## 主题\n- project:f0.md: x' },
    }))
    const rawTotal = FILE_COUNT * RAW_BODY_LEN
    expect(capturedPrompt.length).toBeLessThan(rawTotal) // 远低于未截断时的总量
    expect(capturedPrompt.length).toBeLessThan(60_000) // TOTAL_BODIES_MAX(40000) + manifest + 固定文案，留足余量
    expect(fs.existsSync(path.join(dir, '.index.md'))).toBe(true) // 仍成功写出
  })
})

describe('parseMemoryConfig indexConsolidation', () => {
  it('默认 enabled 为 true', () => {
    expect(DEFAULT_MEMORY_CONFIG.indexConsolidation.enabled).toBe(true)
    expect(parseMemoryConfig({}).indexConsolidation.enabled).toBe(true)
  })
  it('可覆盖为 false', () => {
    expect(parseMemoryConfig({ indexConsolidation: { enabled: false } }).indexConsolidation.enabled).toBe(false)
  })
})
