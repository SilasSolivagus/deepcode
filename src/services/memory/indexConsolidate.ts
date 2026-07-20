import fs from 'node:fs'
import path from 'node:path'
import type OpenAI from 'openai'
import { scanMemoryFiles, formatMemoryManifest, type MemoryScope } from '../../memdir/memoryScan.js'
import { parseFrontmatter } from '../../agentsLoader.js'
import { buildThinkingParams } from '../../api.js'
import { activeModelMeta } from '../../providers.js'

export interface IndexConsolidateDeps {
  client: OpenAI
  model: string
  memdir: string
  globalMemdir?: string
  signal: AbortSignal
  /** 可注入的生成函数（测试用）。默认走 client。 */
  generate?: (prompt: string) => Promise<string>
}

const SYS = '你把一批记忆归纳成一份精简、按主题分组、每条一行的索引，供快速扫读。只输出 Markdown 索引正文：以 `## 主题名` 分组，组下每条形如 `- scope:文件名: 浓缩描述`。不要编造、不要漏条、不要输出别的话。'

/** 单文件正文截断上限（字符）：防止个别超长记忆撑爆 prompt。 */
const PER_FILE_MAX = 2000
/** 全部正文拼接总上限（字符）：大 memdir 下防止 prompt 超出模型上下文导致 create 抛错、.index.md 留旧、live MEMORY.md 被静态索引遮蔽。 */
const TOTAL_BODIES_MAX = 40000
const TRUNC_MARK = '…（截断）'

export function buildIndexPrompt(manifest: string, bodies: string): string {
  return `记忆清单：\n${manifest}\n\n各条正文：\n${bodies}\n\n把它们归纳成按主题分组的一行式索引。`
}

async function defaultGenerate(deps: IndexConsolidateDeps, prompt: string): Promise<string> {
  const res = await deps.client.chat.completions.create({
    model: deps.model, max_tokens: 2048,
    // thinking 模型（glm）绕过 buildThinkingParams 会击穿 content（第一层血的教训）
    ...buildThinkingParams(activeModelMeta(deps.model).supportsThinking, false, undefined),
    messages: [{ role: 'system', content: SYS }, { role: 'user', content: prompt }],
  } as any, { signal: deps.signal })
  return (res as any).choices?.[0]?.message?.content ?? ''
}

/** 原子写：写临时文件再 rename，避免并发/中断留半成品。 */
function atomicWrite(target: string, content: string): void {
  const tmp = target + '.tmp-' + process.pid
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, target)
}

async function consolidateOne(deps: IndexConsolidateDeps, memdir: string, scope: MemoryScope): Promise<void> {
  try {
    const heads = await scanMemoryFiles(memdir, scope)
    if (!heads.length) return
    // 无变化跳过：没有比 .index.md 更新的记忆 → 索引已是最新，不重算。
    // 同时消除两处浪费：①每次 dream 无脑重算全量 ②全局抽屉跨项目双花（只有真新增/改动
    // 全局记忆的那次 dream 才会重建全局索引，其余项目的 dream 一律跳过）。
    // 注：纯删除不改 mtime，删后索引会残留一条陈旧指针，直到下次有新增/改动记忆触发重建才清除
    // ——可接受折衷（SearchMemory 与最近尾巴都不会命中已删文件，危害低）。
    const indexPath = path.join(memdir, '.index.md')
    let indexMtime = 0
    try { indexMtime = fs.statSync(indexPath).mtimeMs } catch { /* 无索引 → 首次生成 */ }
    if (indexMtime > 0 && Math.max(...heads.map(h => h.mtimeMs)) <= indexMtime) return
    const manifest = formatMemoryManifest(heads)
    let bodiesTotal = 0
    const bodyChunks: string[] = []
    for (const h of heads) {
      let body: string
      try { body = parseFrontmatter(fs.readFileSync(h.filePath, 'utf8')).body.trim() }
      catch { continue }
      if (!body) continue
      if (body.length > PER_FILE_MAX) body = body.slice(0, PER_FILE_MAX) + TRUNC_MARK
      if (bodiesTotal + body.length > TOTAL_BODIES_MAX) break // 总量封顶：manifest 仍完整列出全部文件，只是正文停止追加
      bodiesTotal += body.length
      bodyChunks.push(`### ${h.filename}\n${body}`)
    }
    const bodies = bodyChunks.join('\n\n')
    const gen = deps.generate ?? ((p: string) => defaultGenerate(deps, p))
    const out = (await gen(buildIndexPrompt(manifest, bodies))).trim()
    if (!out) return
    atomicWrite(path.join(memdir, '.index.md'), out)
  } catch (e: any) {
    console.error('[memory] indexConsolidation 失败：' + (e?.message ?? e))
  }
}

export async function runIndexConsolidation(deps: IndexConsolidateDeps): Promise<void> {
  await consolidateOne(deps, deps.memdir, 'project')
  if (deps.globalMemdir) await consolidateOne(deps, deps.globalMemdir, 'global')
}
