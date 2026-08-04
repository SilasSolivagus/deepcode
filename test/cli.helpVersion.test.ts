import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HELP } from '../src/help.js'
import { VERSION } from '../src/version.js'
import { PERMISSION_MODES } from '../src/permissions.js'

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts')

/** 真起一个进程跑入口。stdio 的 stdin 给 'pipe' 且不写入即关闭——复现「非 TTY」这个
 *  出 bug 的场景：修复前正是这条路径掉进读 stdin 的分支、回一句「stdin 为空」。 */
function run(args: string[]) {
  const r = spawnSync('npx', ['tsx', ENTRY, ...args], {
    encoding: 'utf8',
    input: '',
    timeout: 60_000,
    env: { ...process.env, DEEPCODE_DISABLE_UPDATES: '1' },
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('deepcode --help / --version', () => {
  it('--help 打帮助并以 0 退出（回归：修复前在非 TTY 下回「stdin 为空」）', () => {
    const r = run(['--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('用法：')
    expect(r.stdout).not.toContain('stdin 为空')
  }, 70_000)

  it('-h 与 --help 等价', () => {
    expect(run(['-h']).stdout).toBe(run(['--help']).stdout)
  }, 140_000)

  it('--version / -v 只打版本号并以 0 退出', () => {
    for (const flag of ['--version', '-v']) {
      const r = run([flag])
      expect(r.status).toBe(0)
      expect(r.stdout.trim()).toBe(VERSION)
    }
  }, 140_000)

  it('--help 在 -p 之前短路：给了任务也不会真去调模型', () => {
    // 没有 API key 时 -p 会抛 NO_KEY_MSG；--help 若没短路成功就会看到那条消息。
    const r = run(['--help', '-p', '写个 hello world'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('用法：')
    expect(r.stderr).not.toContain('未配置任何模型 API key')
  }, 70_000)
})

describe('HELP 正文与真实参数一致', () => {
  it('列出了所有在用户可达路径上生效的参数', () => {
    for (const f of ['--output-format', '--json', '--max-turns', '--trace', '--yolo',
                     '--continue', '--resume', '--inline', '--model', '--permission-mode',
                     '--settings', '--help', '--version']) {
      expect(HELP, `HELP 漏了 ${f}`).toContain(f)
    }
  })

  it('不列 --background-run / --job——它们是 /background 拉起子进程用的内部参数，不面向用户', () => {
    expect(HELP).not.toContain('--background-run')
    expect(HELP).not.toContain('--job')
  })

  it('--permission-mode 列全了六个取值，漏一个用户就以为不支持', () => {
    for (const m of PERMISSION_MODES) expect(HELP, `帮助里漏了 ${m}`).toContain(m)
  })

  it('帮助里带上当前版本号', () => {
    expect(HELP).toContain(VERSION)
  })
})
