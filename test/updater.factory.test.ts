import { describe, it, expect, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { createUpdaterDeps } from '../src/updater.js'

describe('createUpdaterDeps', () => {
  it('组装出完整 deps，不执行任何副作用', () => {
    const onStatus = vi.fn()
    const deps = createUpdaterDeps({
      dir: path.join(os.tmpdir(), 'dc-factory-none'),
      currentVersion: '0.9.2',
      autoUpdates: undefined,
      onStatus,
    })
    expect(deps.currentVersion).toBe('0.9.2')
    expect(typeof deps.fetchLatest).toBe('function')
    expect(typeof deps.runUpgrade).toBe('function')
    expect(deps.registry.startsWith('http')).toBe(true)
    expect(['npm-global', 'foreign', 'dev']).toContain(deps.install.kind)
    expect(onStatus).not.toHaveBeenCalled()
  })

  it('测试进程不会被判成可自动升级的全局安装', () => {
    const deps = createUpdaterDeps({
      dir: path.join(os.tmpdir(), 'dc-factory-dev'),
      currentVersion: '0.9.2',
      autoUpdates: undefined,
      onStatus: () => {},
    })
    // argv[1] 是仓库内的测试入口——无论判成 dev 还是 foreign，都绝不能是 npm-global
    // （否则跑测试就可能触发真实 npm 升级）
    expect(deps.install.kind).not.toBe('npm-global')
  })

  it('force 透传', () => {
    const deps = createUpdaterDeps({
      dir: path.join(os.tmpdir(), 'dc-factory-force'),
      currentVersion: '0.9.2', autoUpdates: undefined, onStatus: () => {}, force: true,
    })
    expect(deps.force).toBe(true)
  })
})
