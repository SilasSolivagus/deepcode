// 补齐绕过 chatStream 的旁路调用点。
//
// 背景：B-1 交付时把「chatStream 是所有出站请求的唯一收口」写进了 spec、源码注释与 README，
// 全分支终审证伪了这个论断——有 5 处直接调 client.chat.completions.create 绕过它。
// 它们当时只在 TUI 路径可达而轨迹只接 headless，故 headless 下覆盖完整，但那是接线错开
// 的巧合而非构造保证。本文件覆盖其中值得记录的 3 处。
//
// 刻意不记的 2 处（登记在此，避免后人重新纠结）：
// - imageDescribe：发出去的是图片，不是「deepcode 自己说的话」，不属本功能的目标内容
// - keyValidate：探活 ping，内容零诊断价值，且它带 key 校验语义，落盘反而多一份敏感面
//
// 每处都必须遵守 B-1 立下的那条不变式：**请求体只拼一次，同一个对象既落盘又发送**。
// 若落盘时重新拼一份，轨迹记的就成了「我们以为发了什么」，本功能的全部价值即失效。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { enableTrace, disableTrace } from '../src/requestTrace.js'

/** autoMode 的分类器客户端由 api.createClient 造。
 *  不能用 vi.spyOn 替换——ESM 的模块命名空间是只读的，spy 会静默失效，
 *  结果是真去发网络请求、classify 落进 fail-safe 返回 'ask'（踩过一次）。
 *  必须用 vi.mock + importOriginal 真正替换该导出，其余导出保持原样。 */
let classifierClient: any
vi.mock('../src/api.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/api.js')>()
  return { ...actual, createClient: () => classifierClient }
})

/** 读出目录里全部轨迹记录，按 seq 升序。 */
function records(dir: string): any[] {
  return readdirSync(dir)
    .filter(f => f.startsWith('req-'))
    .sort()
    .map(f => JSON.parse(readFileSync(path.join(dir, f), 'utf8')))
}

/** 造一个假客户端：记下真正传给 create() 的请求体，并返回一个最小可用的响应。 */
function fakeClient(content = 'yes') {
  const seen: any[] = []
  return {
    seen,
    client: {
      chat: {
        completions: {
          create: async (body: any) => {
            seen.push(body)
            return { choices: [{ message: { content } }], usage: undefined }
          },
        },
      },
    } as any,
  }
}

let dir: string
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'dc-bypass-')) })
afterEach(() => { disableTrace(); vi.restoreAllMocks() })

describe('autoMode 权限分类器（label: classify）', () => {
  // 这是 5 处旁路里最值钱的一处：它发的是 deepcode 自撰的分类器系统提示词 +
  // 最多 4000 字符的兄弟工具输出，正是「请求侧轨迹」定义的目标内容。
  it('落盘的 messages 与真正发给 create() 的是同一份，且带 classify 标签', async () => {
    enableTrace(dir)
    // 分类器要的是 JSON，不是裸字符串（parseDecision 从中抠 {"decision":...}）
    const { client, seen } = fakeClient('{"reasoning":"t","decision":"run"}')
    classifierClient = client
    const autoMode = await import('../src/autoMode.js')
    autoMode.__resetClassifierClient()

    const decision = await autoMode.classify('Bash', 'npm test', '兄弟工具的输出内容', {
      loadSettings: (() => ({ provider: 'glm', permissions: { allow: [] } })) as any,
    })
    expect(decision).toBe('run') // 确认真的走完了分类流程，而非在 catch 里降级

    expect(seen.length, '应当真的发出了分类请求').toBe(1)
    const recs = records(dir)
    expect(recs).toHaveLength(1)
    expect(recs[0].label).toBe('classify')
    expect(recs[0].messages).toEqual(seen[0].messages)
    // 目标内容确实落进了轨迹
    expect(JSON.stringify(recs[0].messages)).toContain('兄弟工具的输出内容')
  })

  it('未开启轨迹时不落盘', async () => {
    const { client } = fakeClient('{"reasoning":"t","decision":"run"}')
    classifierClient = client
    const autoMode = await import('../src/autoMode.js')
    autoMode.__resetClassifierClient()
    await autoMode.classify('Bash', 'npm test', '', { loadSettings: (() => ({ provider: 'glm', permissions: { allow: [] } })) as any })
    expect(readdirSync(dir).filter(f => f.startsWith('req-'))).toHaveLength(0)
  })
})

describe('记忆信号门控 hasDurableSignal（label: memorySignal）', () => {
  it('落盘的 messages 与真正发给 create() 的是同一份，且带 memorySignal 标签', async () => {
    enableTrace(dir)
    const { client, seen } = fakeClient('yes')
    const { hasDurableSignal } = await import('../src/services/memory/signalGate.js')
    await hasDurableSignal(client, 'deepseek-v4-flash', [{ role: 'user', content: '我不喜欢 tailwind' }],
      new AbortController().signal)

    const recs = records(dir)
    expect(recs).toHaveLength(1)
    expect(recs[0].label).toBe('memorySignal')
    expect(recs[0].model).toBe('deepseek-v4-flash')
    // 关键不变式：轨迹里的 messages 必须与真正上线的逐字一致
    expect(seen).toHaveLength(1)
    expect(recs[0].messages).toEqual(seen[0].messages)
    // params 照实落盘：max_tokens 等非 model/messages/tools 的键都要在
    expect(recs[0].params.max_tokens).toBe(4)
  })

  it('未开启轨迹时不落盘', async () => {
    const { client } = fakeClient('yes')
    const { hasDurableSignal } = await import('../src/services/memory/signalGate.js')
    await hasDurableSignal(client, 'deepseek-v4-flash', [{ role: 'user', content: 'x' }],
      new AbortController().signal)
    expect(readdirSync(dir).filter(f => f.startsWith('req-'))).toHaveLength(0)
  })
})

describe('记忆索引整合（label: memoryIndex）', () => {
  it('落盘的 messages 与真正发给 create() 的是同一份，且带 memoryIndex 标签', async () => {
    enableTrace(dir)
    const { client, seen } = fakeClient('- 主题 A：xxx')
    const { runIndexConsolidation } = await import('../src/services/memory/indexConsolidate.js')
    // 造一个有内容的 memdir，否则没东西可归纳、根本不会发请求
    const memdir = mkdtempSync(path.join(tmpdir(), 'dc-memdir-'))
    writeFileSync(path.join(memdir, 'a.md'), '---\nname: a\ndescription: d\n---\n\n甲的正文')
    writeFileSync(path.join(memdir, 'b.md'), '---\nname: b\ndescription: e\n---\n\n乙的正文')
    await runIndexConsolidation({
      client, model: 'deepseek-v4-flash', signal: new AbortController().signal, memdir,
    } as any).catch(() => {})

    // 先确认请求真的发出去了——否则下面的断言会在"压根没发请求"时空过，
    // 变成一条实现与否都绿的零区分度用例。
    expect(seen.length, '应当真的发出了索引归纳请求').toBeGreaterThan(0)
    const recs = records(dir)
    expect(recs).toHaveLength(seen.length)
    expect(recs[0].label).toBe('memoryIndex')
    expect(recs[0].messages).toEqual(seen[0].messages)
  })
})
