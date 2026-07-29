import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isInsideWorkspace } from '../src/workspace.js'

const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-ws-sym-'))
afterAll(() => { try { fs.rmSync(lab, { recursive: true, force: true }) } catch { /* 忽略 */ } })

const repo = path.join(lab, 'repo')
const outside = path.join(lab, 'outside')
fs.mkdirSync(repo, { recursive: true })
fs.mkdirSync(outside, { recursive: true })

describe('isInsideWorkspace 双路径判定', () => {
  it('攻击：围栏内的软链指向围栏外 → 判为围栏外', () => {
    const link = path.join(repo, 'escape'); fs.symlinkSync(outside, link)
    expect(isInsideWorkspace(path.join(link, 'x.txt'), [repo])).toBe(false)
  })

  it('回归：围栏内普通路径仍判为内', () => {
    expect(isInsideWorkspace(path.join(repo, 'src', 'a.ts'), [repo])).toBe(true)
  })

  it('回归：root 本身经平台软链给出（macOS /tmp → /private/tmp）不得误拦', () => {
    // lab 建在 os.tmpdir() 下；macOS 上 /tmp 是指向 /private/tmp 的软链。
    // 用逻辑 root + 真实目标（或反之）都必须判为内，否则合法路径会被全拦。
    const realRepo = fs.realpathSync(repo)
    expect(isInsideWorkspace(path.join(realRepo, 'a.ts'), [repo])).toBe(true)
    expect(isInsideWorkspace(path.join(repo, 'a.ts'), [realRepo])).toBe(true)
  })

  it('回归：围栏外普通路径仍判为外', () => {
    expect(isInsideWorkspace(path.join(outside, 'x.txt'), [repo])).toBe(false)
  })
})
