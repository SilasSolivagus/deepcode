export interface MemoryConfig {
  enabled: boolean
  extractEveryTurns: number
  sessionMemory: { enabled: boolean; minInitTokens: number; minUpdateTokens: number; toolCallsBetween: number }
  dream: { enabled: boolean; minHours: number; minSessions: number }
  /** 跨项目全局抽屉。maxBytes = 全文注入预算，超了降级为索引清单。 */
  global: { enabled: boolean; maxBytes: number }
  indexConsolidation: { enabled: boolean }
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  extractEveryTurns: 1,
  sessionMemory: { enabled: true, minInitTokens: 10000, minUpdateTokens: 5000, toolCallsBetween: 3 },
  dream: { enabled: true, minHours: 24, minSessions: 5 },
  global: { enabled: true, maxBytes: 8192 },
  indexConsolidation: { enabled: true },
}

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
const posInt = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d)
const nonNeg = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)

export function parseMemoryConfig(raw: unknown): MemoryConfig {
  const r: any = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const D = DEFAULT_MEMORY_CONFIG
  const sm = r.sessionMemory && typeof r.sessionMemory === 'object' ? r.sessionMemory : {}
  const dr = r.dream && typeof r.dream === 'object' ? r.dream : {}
  const gl = r.global && typeof r.global === 'object' ? r.global : {}
  const ic = r.indexConsolidation && typeof r.indexConsolidation === 'object' ? r.indexConsolidation : {}
  return {
    enabled: bool(r.enabled, D.enabled),
    extractEveryTurns: posInt(r.extractEveryTurns, D.extractEveryTurns),
    sessionMemory: {
      enabled: bool(sm.enabled, D.sessionMemory.enabled),
      minInitTokens: posInt(sm.minInitTokens, D.sessionMemory.minInitTokens),
      minUpdateTokens: posInt(sm.minUpdateTokens, D.sessionMemory.minUpdateTokens),
      toolCallsBetween: posInt(sm.toolCallsBetween, D.sessionMemory.toolCallsBetween),
    },
    dream: {
      enabled: bool(dr.enabled, D.dream.enabled),
      minHours: nonNeg(dr.minHours, D.dream.minHours),
      minSessions: posInt(dr.minSessions, D.dream.minSessions),
    },
    global: {
      enabled: bool(gl.enabled, D.global.enabled),
      maxBytes: posInt(gl.maxBytes, D.global.maxBytes),
    },
    indexConsolidation: { enabled: bool(ic.enabled, D.indexConsolidation.enabled) },
  }
}
