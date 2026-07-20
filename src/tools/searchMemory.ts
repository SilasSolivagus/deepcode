import os from 'node:os'
import { z } from 'zod'
import type { Tool, ToolContext } from './types.js'
import { searchMemories, type SearchHit } from '../memdir/memSearch.js'
import { memdirFor, globalMemdirFor } from '../memdir/paths.js'

const schema = z.object({
  query: z.string().describe('检索词'),
  limit: z.number().int().positive().max(20).optional(),
})

export function formatSearchResults(hits: SearchHit[]): string {
  if (!hits.length) return '没有找到相关记忆。'
  return hits.map(h => `- ${h.key} [${h.scope}]: ${h.description ?? '(无描述)'}\n  ${h.snippet}`).join('\n')
}

export const searchMemoryTool: Tool<typeof schema> = {
  name: 'SearchMemory',
  description: '在你的长期记忆（本项目 + 跨项目全局抽屉）里按关键词全文检索，返回最相关的记忆片段与文件键。记忆索引里没直接看到、但你觉得记忆里可能有相关信息时用它；拿到片段后用 Read 读该 .md 全文再据此作答。',
  inputSchema: schema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(input, ctx: ToolContext): Promise<string> {
    try {
      const home = os.homedir()
      const hits = await searchMemories(
        { project: memdirFor(ctx.cwd(), home), global: globalMemdirFor(home) },
        input.query,
        input.limit ?? 8,
      )
      return formatSearchResults(hits)
    } catch { return '记忆检索暂时不可用。' }
  },
}
