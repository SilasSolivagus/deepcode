// src/mcpRegistry.ts —— MCP 连接状态注册表（pending/connected/failed）+ 资源 caller 抽象。
// 架构铁律：不反向 import loop/useChat/headless。
import type { McpStdioServerConfig } from './config.js'

export type McpServerStatus = 'pending' | 'connected' | 'failed'

export interface McpResource { uri: string; name: string; mimeType?: string; description?: string }
export interface McpResourceContent { uri: string; mimeType?: string; text?: string; blob?: string }

/** 资源读取所需的最小 client 接口（真实即 SDK Client，结构上满足；测试可 mock）。 */
export interface McpResourceCaller {
  getServerCapabilities(): { resources?: unknown } | undefined
  listResources(params?: { cursor?: string }): Promise<{ resources: McpResource[]; nextCursor?: string }>
  readResource(params: { uri: string }): Promise<{ contents: McpResourceContent[] }>
}

export interface McpServerState {
  name: string
  status: McpServerStatus
  config: McpStdioServerConfig
  caller?: McpResourceCaller
  error?: string
}

export interface McpRegistry {
  seedPending(name: string, cfg: McpStdioServerConfig): void
  markConnected(name: string, caller: McpResourceCaller): void
  markFailed(name: string, err: string): void
  list(): McpServerState[]
  pending(): McpServerState[]
  connectedCallers(): Array<{ name: string; caller: McpResourceCaller }>
  hasServers(): boolean
  subscribe(cb: () => void): () => void
}

export function createMcpRegistry(): McpRegistry {
  const states = new Map<string, McpServerState>()
  const subs = new Set<() => void>()
  const notify = () => { for (const cb of subs) { try { cb() } catch { /* 订阅者异常不影响注册表 */ } } }
  return {
    seedPending(name, cfg) { states.set(name, { name, status: 'pending', config: cfg }); notify() },
    markConnected(name, caller) {
      const s = states.get(name)
      if (s) { s.status = 'connected'; s.caller = caller; s.error = undefined } else states.set(name, { name, status: 'connected', config: { command: '' } as McpStdioServerConfig, caller })
      notify()
    },
    markFailed(name, err) {
      const s = states.get(name)
      if (s) { s.status = 'failed'; s.caller = undefined; s.error = err } else states.set(name, { name, status: 'failed', config: { command: '' } as McpStdioServerConfig, error: err })
      notify()
    },
    list() { return [...states.values()] },
    pending() { return [...states.values()].filter(s => s.status === 'pending') },
    connectedCallers() { return [...states.values()].filter(s => s.status === 'connected' && s.caller).map(s => ({ name: s.name, caller: s.caller! })) },
    hasServers() { return states.size > 0 },
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb) },
  }
}
