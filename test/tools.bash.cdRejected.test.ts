import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bashTool } from '../src/tools/bash.js'
import { makeCtx } from './helpers.js'

describe('越界 cd 不静默丢弃', () => {
  it('setCwd 被围栏拒绝 → 结果里告诉模型这次 cd 没生效', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-cdrej-')))
    let cur = dir
    const ctx: any = {
      ...makeCtx(dir),
      cwd: () => cur,
      setCwd: (d: string) => { if (d.startsWith(dir)) cur = d }, // 模拟围栏：越界丢弃
    }
    const out = await bashTool.call({ command: 'cd /' }, ctx)
    expect(out).toContain('未生效')
    expect(out).toContain(dir)      // 提示里带上仍然生效的目录
    expect(cur).toBe(dir)           // 确实没漂移
  })

  it('回归：围栏内的 cd 正常生效，不产生提示', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-cdok-')))
    fs.mkdirSync(path.join(dir, 'sub'))
    let cur = dir
    const ctx: any = {
      ...makeCtx(dir),
      cwd: () => cur,
      setCwd: (d: string) => { if (d.startsWith(dir)) cur = d },
    }
    const out = await bashTool.call({ command: 'cd sub' }, ctx)
    expect(out).not.toContain('未生效')
    expect(cur).toBe(path.join(dir, 'sub'))
  })

  it('cd 被围栏拒绝 → 不派发 CwdChanged（发了就是向 hook 撒谎：目录压根没变）', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-cdrej-hook-')))
    let cur = dir
    const hookDispatch = vi.fn().mockResolvedValue({})
    const ctx: any = {
      ...makeCtx(dir),
      cwd: () => cur,
      setCwd: (d: string) => { if (d.startsWith(dir)) cur = d },
      hookDispatch,
    }
    await bashTool.call({ command: 'cd /' }, ctx)
    expect(hookDispatch).not.toHaveBeenCalledWith('CwdChanged', expect.anything())
  })

  it('回归：围栏内的 cd 正常生效时仍正常派发 CwdChanged', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-cdok-hook-')))
    fs.mkdirSync(path.join(dir, 'sub'))
    let cur = dir
    const hookDispatch = vi.fn().mockResolvedValue({})
    const ctx: any = {
      ...makeCtx(dir),
      cwd: () => cur,
      setCwd: (d: string) => { if (d.startsWith(dir)) cur = d },
      hookDispatch,
    }
    await bashTool.call({ command: 'cd sub' }, ctx)
    expect(hookDispatch).toHaveBeenCalledWith('CwdChanged', expect.objectContaining({ new_cwd: path.join(dir, 'sub') }))
  })
})
