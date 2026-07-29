import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkPermission, type PermissionContext, type Decision } from '../src/permissions.js'
import { readTool } from '../src/tools/read.js'
import { writeTool } from '../src/tools/write.js'
import { makeCtx } from './helpers.js'

// realpath 一次：macOS 的 os.tmpdir() 祖先本身是软链（/var→/private/var），
// 不归一化会让"经软链访问"这个被测条件与平台别名混在一起。软链在此之后才创建，不影响被测条件。
const lab = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-symesc-')))
afterAll(() => { try { fs.rmSync(lab, { recursive: true, force: true }) } catch { /* 忽略 */ } })

const repo = path.join(lab, 'repo')
const outside = path.join(lab, 'outside')
// 密钥目录**放在 repo 内部**：这样第二条攻击里工作目录围栏不会插手，deny 是唯一防线。
const secrets = path.join(repo, 'secrets')
fs.mkdirSync(path.join(repo, 'real'), { recursive: true })
fs.mkdirSync(outside, { recursive: true })
fs.mkdirSync(secrets, { recursive: true })
fs.writeFileSync(path.join(secrets, 'id_rsa'), 'PRIVATE-KEY')

function pc(over: Partial<PermissionContext> = {}): PermissionContext {
  return {
    mode: 'default', rules: [], cwd: repo,
    deny: [path.join(secrets, '**')],
    saveRule: () => {},
    ask: async () => 'no' as Decision, // 无人值守：拒
    ...over,
  }
}

/** 模拟主循环的门控语义：权限过了才真的执行工具。
 *  磁盘状态因此成为真证据——围栏/deny 一旦失效，工具会真的跑，文件会真的出现。 */
async function gatedCall(
  tool: typeof readTool | typeof writeTool,
  input: any,
  ctx = pc(),
): Promise<{ allowed: boolean; output?: string }> {
  const r = await checkPermission(tool as any, input, ctx)
  if (!r.ok) return { allowed: false }
  return { allowed: true, output: await (tool as any).call(input, makeCtx(ctx.cwd!)) }
}

describe('symlink 端到端逃逸（真实文件系统，权限过了才真落盘）', () => {
  // acceptEdits 隔离出围栏：围栏不旁路 acceptEdits，所以围栏是这里唯一能拦住写入的防线。
  // 围栏一旦失效，:489 会自动放行，写入真的落到围栏外——磁盘断言因此是真证据。
  it('攻击：repo 内软链指向围栏外 → Write 被围栏拦，且围栏外磁盘上没产生文件', async () => {
    fs.symlinkSync(outside, path.join(repo, 'esc'))
    let asked = false
    const r = await gatedCall(
      writeTool,
      { file_path: path.join(repo, 'esc', 'pwned.txt'), content: 'PWNED' },
      pc({ mode: 'acceptEdits', ask: async () => { asked = true; return 'no' as Decision } }),
    )
    expect(asked).toBe(true) // 围栏确实触发了弹窗（不是被别的关卡拦的）
    expect(r.allowed).toBe(false)
    expect(fs.existsSync(path.join(outside, 'pwned.txt'))).toBe(false)
  })

  // secrets 在 repo 内 → 围栏不插手，deny 是唯一防线。
  // deny 的真实路径分支一旦失效，readTool 会走 :470 只读放行，私钥真的被读出来。
  it('攻击：repo 内软链指向 deny 目录 → Read 被 deny 拦，且私钥内容没被读出', async () => {
    fs.symlinkSync(secrets, path.join(repo, 'slink'))
    const r = await gatedCall(readTool, { file_path: path.join(repo, 'slink', 'id_rsa') })
    expect(r.allowed).toBe(false)
    expect(r.output ?? '').not.toContain('PRIVATE-KEY')
  })

  it('回归：repo 内正常路径放行，且内容真的写进去了', async () => {
    const f = path.join(repo, 'src', 'ok.ts')
    const r = await gatedCall(writeTool, { file_path: f, content: 'hi' }, pc({ ask: async () => 'yes' as Decision }))
    expect(r.allowed).toBe(true)
    expect(fs.readFileSync(f, 'utf8')).toBe('hi')
  })

  it('回归：repo 内软链指向 repo 内 → 放行，且写入落在软链的真实目标上', async () => {
    fs.symlinkSync(path.join(repo, 'real'), path.join(repo, 'inner'))
    const r = await gatedCall(writeTool, { file_path: path.join(repo, 'inner', 'x.txt'), content: 'ok' }, pc({ ask: async () => 'yes' as Decision }))
    expect(r.allowed).toBe(true)
    expect(fs.readFileSync(path.join(repo, 'real', 'x.txt'), 'utf8')).toBe('ok')
  })
})
