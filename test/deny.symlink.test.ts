import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isDeniedPath } from '../src/deny.js'

// realpath 一次：macOS 下 os.tmpdir() 本身经 /var -> /private/var 符号链接，
// 不 realpath 会把这条系统级符号链接也算进「未解析前缀」，污染下面专门构造的攻击符号链接。
const lab = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-deny-sym-')))
afterAll(() => { try { fs.rmSync(lab, { recursive: true, force: true }) } catch { /* 忽略 */ } })

describe('isDeniedPath 双路径判定', () => {
  it('攻击：软链指向被 deny 的目录 → 经软链访问仍被拒', () => {
    const secretDir = path.join(lab, 'vault'); fs.mkdirSync(secretDir, { recursive: true })
    fs.writeFileSync(path.join(secretDir, 'id_rsa'), 'KEY')
    const link = path.join(lab, 'innocent'); fs.symlinkSync(secretDir, link)
    // deny 规则写的是真实目录
    const patterns = [path.join(secretDir, '**')]
    expect(isDeniedPath(path.join(link, 'id_rsa'), patterns)).not.toBeNull()
  })

  it('反向回归：被 deny 的目录本身是软链 → 按逻辑路径写的规则仍命中', () => {
    const realDir = path.join(lab, 'real-ssh'); fs.mkdirSync(realDir, { recursive: true })
    fs.writeFileSync(path.join(realDir, 'id_rsa'), 'KEY')
    const sshLink = path.join(lab, 'dot-ssh'); fs.symlinkSync(realDir, sshLink)
    // 用户按逻辑路径写规则；canon 后会变成 real-ssh，若只判真实路径这条就失效了
    const patterns = [path.join(sshLink, '**')]
    expect(isDeniedPath(path.join(sshLink, 'id_rsa'), patterns)).not.toBeNull()
  })

  it('未命中任何规则仍返回 null（不误报）', () => {
    fs.writeFileSync(path.join(lab, 'plain.txt'), 'x')
    expect(isDeniedPath(path.join(lab, 'plain.txt'), ['**/id_rsa'])).toBeNull()
  })
})
