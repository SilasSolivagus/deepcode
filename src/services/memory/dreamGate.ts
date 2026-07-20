import { readLastConsolidatedAt } from './consolidationLock.js'
import type { MemoryConfig } from '../../memdir/memoryConfig.js'
import { listProjectSessions } from '../../memdir/projectSessions.js'

const RESCAN_MS = 600_000 // 时间过但会话不过：10min 内不再扫

/** 单一事实源见 memdir/projectSessions.ts；本函数仅做「取文件白名单再数长度」的薄封装（保留导出以免破坏既有测试）。 */
export function countSessionsTouchedSince(sessionsDir: string, sinceMs: number, currentSessionFile: string, projectKey: string): number {
  return listProjectSessions(sessionsDir, projectKey, sinceMs, currentSessionFile).length
}

export interface DreamGateDeps {
  memdir: string; sessionsDir: string; currentSessionFile: string
  projectKey: string
  cfg: MemoryConfig['dream']; now: number; lastScanAt: number
  readLastAt?: (memdir: string) => number
  listSessions?: (sessionsDir: string, projectKey: string, sinceMs: number, cur: string) => string[]
}

export interface DreamGateResult { pass: boolean; reason?: string; n: number; sessionFiles: string[] }

export function checkDreamGates(d: DreamGateDeps): DreamGateResult {
  const lastAt = (d.readLastAt ?? readLastConsolidatedAt)(d.memdir)
  const hoursSince = (d.now - lastAt) / 3600_000
  if (hoursSince < d.cfg.minHours) return { pass: false, reason: 'time', n: 0, sessionFiles: [] }
  if (d.now - d.lastScanAt < RESCAN_MS && d.lastScanAt > 0) return { pass: false, reason: 'rescan-throttle', n: 0, sessionFiles: [] }
  const sessionFiles = d.listSessions
    ? d.listSessions(d.sessionsDir, d.projectKey, lastAt, d.currentSessionFile)
    : listProjectSessions(d.sessionsDir, d.projectKey, lastAt, d.currentSessionFile)
  if (sessionFiles.length < d.cfg.minSessions) return { pass: false, reason: 'sessions', n: sessionFiles.length, sessionFiles }
  return { pass: true, n: sessionFiles.length, sessionFiles }
}
