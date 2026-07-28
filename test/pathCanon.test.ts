import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canonPath } from '../src/pathCanon.js'

const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-canon-'))
afterAll(() => { try { fs.rmSync(lab, { recursive: true, force: true }) } catch { /* 忽略 */ } })

describe('canonPath', () => {
  it('解析 symlink 到真实路径', () => {
    const real = path.join(lab, 'real'); fs.mkdirSync(real, { recursive: true })
    const link = path.join(lab, 'link'); fs.symlinkSync(real, link)
    expect(canonPath(link)).toBe(fs.realpathSync(real))
  })

  it('路径不存在时解析最深存在祖先再拼回剩余段', () => {
    const real = path.join(lab, 'real2'); fs.mkdirSync(real, { recursive: true })
    const link = path.join(lab, 'link2'); fs.symlinkSync(real, link)
    // link2/nope/deep.txt 不存在：应解析到 realpath(real2)/nope/deep.txt
    expect(canonPath(path.join(link, 'nope', 'deep.txt')))
      .toBe(path.join(fs.realpathSync(real), 'nope', 'deep.txt'))
  })

  it('折叠 ..', () => {
    const real = path.join(lab, 'a', 'b'); fs.mkdirSync(real, { recursive: true })
    expect(canonPath(path.join(real, '..', 'b'))).toBe(fs.realpathSync(real))
  })

  it('完全不存在的路径回落 path.resolve，不抛', () => {
    const p = path.join(lab, 'no', 'such', 'file')
    expect(canonPath(p)).toBe(path.join(fs.realpathSync(lab), 'no', 'such', 'file'))
  })
})
