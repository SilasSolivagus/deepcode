import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startUpdateCheck, writeUpdateState, type UpdaterDeps, type UpdateStatus } from '../src/updater.js'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-orch-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const NOW = 1_700_000_000_000

function mk(over: Partial<UpdaterDeps> = {}): { deps: UpdaterDeps; seen: UpdateStatus[] } {
  const seen: UpdateStatus[] = []
  const deps: UpdaterDeps = {
    dir, env: {}, now: () => NOW, currentVersion: '0.9.2',
    install: { kind: 'npm-global', upgradeCommand: 'npm i -g @silassolivagus/deepcode@latest' },
    autoUpdates: undefined,
    registry: 'https://r.example',
    fetchLatest: vi.fn(async () => '0.9.3'),
    runUpgrade: vi.fn(async () => true),
    onStatus: s => seen.push(s),
    ...over,
  }
  return { deps, seen }
}

describe('startUpdateCheck', () => {
  it('有新版 + npm-global → 执行升级，终态 upgraded', async () => {
    const { deps, seen } = mk()
    await startUpdateCheck(deps)
    expect(deps.runUpgrade).toHaveBeenCalled()
    expect(seen.at(-1)).toEqual({ phase: 'upgraded', latest: '0.9.3' })
  })

  it('有新版 + foreign → 不升级，终态 available 带对应命令', async () => {
    const { deps, seen } = mk({ install: { kind: 'foreign', upgradeCommand: 'bun add -g x@latest' } })
    await startUpdateCheck(deps)
    expect(deps.runUpgrade).not.toHaveBeenCalled()
    expect(seen.at(-1)).toEqual({ phase: 'available', latest: '0.9.3', command: 'bun add -g x@latest' })
  })

  it('已是最新 → 不升级、无终态提示，但写节流状态', async () => {
    const { deps, seen } = mk({ fetchLatest: vi.fn(async () => '0.9.2') })
    await startUpdateCheck(deps)
    expect(deps.runUpgrade).not.toHaveBeenCalled()
    expect(seen.filter(s => s.phase === 'available' || s.phase === 'upgraded')).toHaveLength(0)
    expect(fs.existsSync(path.join(dir, 'update.json'))).toBe(true)
  })

  it('dev 形态 → 一次网络都不打', async () => {
    const { deps, seen } = mk({ install: { kind: 'dev', upgradeCommand: 'x' } })
    await startUpdateCheck(deps)
    expect(deps.fetchLatest).not.toHaveBeenCalled()
    expect(seen).toEqual([])
  })

  it('DEEPCODE_DISABLE_UPDATES=1 → 一次网络都不打', async () => {
    const { deps, seen } = mk({ env: { DEEPCODE_DISABLE_UPDATES: '1' } })
    await startUpdateCheck(deps)
    expect(deps.fetchLatest).not.toHaveBeenCalled()
    expect(seen).toEqual([])
  })

  it('autoUpdates:false → 查但不升，终态 available', async () => {
    const { deps, seen } = mk({ autoUpdates: false })
    await startUpdateCheck(deps)
    expect(deps.fetchLatest).toHaveBeenCalled()
    expect(deps.runUpgrade).not.toHaveBeenCalled()
    expect(seen.at(-1)).toMatchObject({ phase: 'available', latest: '0.9.3' })
  })

  it('DEEPCODE_DISABLE_AUTOUPDATER=1 → 查但不升', async () => {
    const { deps, seen } = mk({ env: { DEEPCODE_DISABLE_AUTOUPDATER: '1' } })
    await startUpdateCheck(deps)
    expect(deps.runUpgrade).not.toHaveBeenCalled()
    expect(seen.at(-1)).toMatchObject({ phase: 'available' })
  })

  it('24h 内已查过 → 跳过；force 可绕过节流', async () => {
    writeUpdateState(dir, { lastCheckAt: NOW - 1000, latest: '0.9.2' })
    const a = mk()
    await startUpdateCheck(a.deps)
    expect(a.deps.fetchLatest).not.toHaveBeenCalled()

    const b = mk({ force: true })
    await startUpdateCheck(b.deps)
    expect(b.deps.fetchLatest).toHaveBeenCalled()
  })

  it('查询失败 → 无终态提示，不抛异常', async () => {
    const { deps, seen } = mk({ fetchLatest: vi.fn(async () => null) })
    await expect(startUpdateCheck(deps)).resolves.toBeUndefined()
    expect(seen.filter(s => s.phase === 'available' || s.phase === 'upgraded')).toHaveLength(0)
  })

  it('升级失败 → 终态 failed 带手动命令', async () => {
    const { deps, seen } = mk({ runUpgrade: vi.fn(async () => false) })
    await startUpdateCheck(deps)
    expect(seen.at(-1)).toEqual({ phase: 'failed', command: 'npm i -g @silassolivagus/deepcode@latest' })
  })

  it('runUpgrade 抛异常 → 终态 failed，不外溢', async () => {
    const { deps, seen } = mk({ runUpgrade: vi.fn(async () => { throw new Error('boom') }) })
    await expect(startUpdateCheck(deps)).resolves.toBeUndefined()
    expect(seen.at(-1)).toMatchObject({ phase: 'failed' })
  })

  it('锁被活进程占用 → 不升级，退回 available', async () => {
    fs.writeFileSync(path.join(dir, 'update.lock'), String(process.pid))
    const { deps, seen } = mk()
    await startUpdateCheck(deps)
    expect(deps.runUpgrade).not.toHaveBeenCalled()
    expect(seen.at(-1)).toMatchObject({ phase: 'available' })
  })

  it('升级完成后释放锁', async () => {
    const { deps } = mk()
    await startUpdateCheck(deps)
    expect(fs.existsSync(path.join(dir, 'update.lock'))).toBe(false)
  })
})
