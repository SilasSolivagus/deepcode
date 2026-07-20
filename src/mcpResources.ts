// src/mcpResources.ts —— MCP 资源工具（List/Read/Wait）。从 mcpRegistry 读连接状态。
// 架构铁律：不反向 import loop/useChat/headless。
import { z } from 'zod'
import type { Tool } from './tools/types.js'
import type { McpRegistry, McpResource } from './mcpRegistry.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const DEFAULT_MAX_PAGES = 10
const DEFAULT_POLL_MS = 50
const DEFAULT_TIMEOUT_MS = 5000

function extFromMime(mime?: string): string {
  if (!mime) return 'bin'
  const sub = mime.split('/')[1] ?? 'bin'
  return sub.split('+')[0].replace(/[^a-z0-9]/gi, '') || 'bin'
}

export function makeListMcpResourcesTool(registry: McpRegistry, opts: { maxPages?: number } = {}): Tool {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES
  return {
    name: 'ListMcpResources',
    description: '列出已连接 MCP server 提供的资源。每个资源对象含 server 字段标明来源。可选 server 参数只列该 server。',
    inputSchema: z.object({ server: z.string().optional() }),
    isReadOnly: true,
    needsPermission: () => false,
    async call(input: { server?: string }) {
      const all = registry.connectedCallers()
      let targets = all
      if (input.server) {
        targets = all.filter(c => c.name === input.server)
        if (targets.length === 0) throw new Error(`Server "${input.server}" not found. Available servers: ${all.map(c => c.name).join(', ') || '(none)'}`)
      }
      const out: Array<McpResource & { server: string }> = []
      for (const { name, caller } of targets) {
        if (!caller.getServerCapabilities()?.resources) continue // 能力 gate：不声明 resources 跳过
        try {
          let cursor: string | undefined
          for (let page = 0; page < maxPages; page++) {
            const res = await caller.listResources(cursor ? { cursor } : undefined)
            for (const r of res.resources ?? []) out.push({ ...r, server: name })
            if (!res.nextCursor) break
            cursor = res.nextCursor
          }
        } catch { /* 单 server 失败降级：跳过该 server，不整体失败 */ }
      }
      return JSON.stringify(out, null, 2)
    },
  }
}

export function makeReadMcpResourceTool(registry: McpRegistry, opts: { blobDir?: string } = {}): Tool {
  const blobDir = opts.blobDir ?? join(tmpdir(), 'deepcode-mcp-resources')
  return {
    name: 'ReadMcpResource',
    description: '按 server 名和资源 URI 读取一个 MCP 资源。文本内联返回；二进制内容保存到磁盘并回传路径。',
    inputSchema: z.object({ server: z.string(), uri: z.string() }),
    isReadOnly: true,
    needsPermission: () => false,
    async call(input: { server: string; uri: string }) {
      const found = registry.connectedCallers().find(c => c.name === input.server)
      if (!found) throw new Error(`Server "${input.server}" not found. Available servers: ${registry.connectedCallers().map(c => c.name).join(', ') || '(none)'}`)
      let result: { contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> }
      try {
        result = await found.caller.readResource({ uri: input.uri })
      } catch (e: any) {
        const code = e?.code
        if (code === -32601) return JSON.stringify({ contents: [], error: `Server "${input.server}" advertises resource support but does not implement resource reads.` }, null, 2)
        if (code === -32002 || code === -32602) return JSON.stringify({ contents: [], error: `Resource not found: ${input.uri}. Re-run ListMcpResources to refresh, then retry.` }, null, 2)
        throw e
      }
      const contents = (result.contents ?? []).map(c => {
        if (typeof c.text === 'string') return { uri: c.uri, mimeType: c.mimeType, text: c.text }
        if (typeof c.blob === 'string') {
          mkdirSync(blobDir, { recursive: true })
          const path = join(blobDir, `mcp-${randomBytes(6).toString('hex')}.${extFromMime(c.mimeType)}`)
          writeFileSync(path, Buffer.from(c.blob, 'base64'))
          return { uri: c.uri, mimeType: c.mimeType, blobSavedTo: path }
        }
        return { uri: c.uri, mimeType: c.mimeType }
      })
      return JSON.stringify({ contents }, null, 2)
    },
  }
}

export function makeWaitForMcpServersTool(
  registry: McpRegistry,
  opts: { pollMs?: number; timeoutMs?: number; now?: () => number } = {},
): Tool {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = opts.now ?? (() => Date.now())
  return {
    name: 'WaitForMcpServers',
    description: '等待仍在连接的 MCP server 就绪（最多 5 秒）。可选 servers 参数只等指定 server；默认等所有 pending server。',
    inputSchema: z.object({ servers: z.array(z.string()).optional() }),
    isReadOnly: true,
    needsPermission: () => false,
    async call(input: { servers?: string[] }, ctx) {
      const want = input.servers?.length ? new Set(input.servers) : null // null=所有 pending
      const stillPending = () => registry.pending().map(s => s.name).filter(n => !want || want.has(n))
      const deadline = now() + timeoutMs
      while (stillPending().length > 0 && now() < deadline && !ctx.signal.aborted) {
        await new Promise(res => setTimeout(res, pollMs))
      }
      const list = registry.list()
      const inScope = (n: string) => !want || want.has(n)
      const connected = list.filter(s => s.status === 'connected' && inScope(s.name)).map(s => s.name)
      const failed = list.filter(s => s.status === 'failed' && inScope(s.name)).map(s => s.name)
      const pending = stillPending()
      return JSON.stringify({ ready: pending.length === 0, connected, failed, stillPending: pending }, null, 2)
    },
  }
}

/** 三个资源工具聚合，供连接器统一追加进 tools 池。 */
export function makeMcpResourceTools(registry: McpRegistry): Tool[] {
  return [makeListMcpResourcesTool(registry), makeReadMcpResourceTool(registry), makeWaitForMcpServersTool(registry)]
}
