import { describe, it, expect } from 'vitest'
import { detectInstall } from '../src/updater.js'

const noGit = () => false
const writable = () => true
const notWritable = () => false

describe('detectInstall', () => {
  it('npm 全局 node_modules 内 + 可写 → npm-global', () => {
    const r = detectInstall(
      '/opt/homebrew/lib/node_modules/@silassolivagus/deepcode/dist/index.js',
      '/opt/homebrew',
      noGit,
      writable,
    )
    expect(r.kind).toBe('npm-global')
    expect(r.upgradeCommand).toBe('npm i -g @silassolivagus/deepcode@latest')
  })

  it('npm 全局 node_modules 内但不可写（如 sudo npm i -g 装到 root 属主）→ 降级 foreign，命令带 sudo（Bug#5）', () => {
    const r = detectInstall(
      '/opt/homebrew/lib/node_modules/@silassolivagus/deepcode/dist/index.js',
      '/opt/homebrew',
      noGit,
      notWritable,
    )
    expect(r.kind).toBe('foreign')
    expect(r.upgradeCommand).toBe('sudo npm i -g @silassolivagus/deepcode@latest')
  })

  it('prefix 顶层可写但 lib/node_modules 不可写（sudo npm i -g 装到 root 属主，homebrew/nvm 前缀本身归用户）→ foreign，不能只查 prefix 顶层', () => {
    // 只有 prefix 顶层可写；真正的写入点 lib/node_modules 及 scope 目录都不可写
    const isWritable = (dir: string) => dir === '/opt/homebrew'
    const r = detectInstall(
      '/opt/homebrew/lib/node_modules/@silassolivagus/deepcode/dist/index.js',
      '/opt/homebrew',
      noGit,
      isWritable,
    )
    expect(r.kind).toBe('foreign')
    expect(r.upgradeCommand).toBe('sudo npm i -g @silassolivagus/deepcode@latest')
  })

  it('prefix 顶层不可写但 lib/node_modules 与 scope 目录都可写（sudo chown -R 修过 npm EACCES 后，/usr/local 顶层仍归 root）→ npm-global', () => {
    const isWritable = (dir: string) =>
      dir === '/opt/homebrew/lib/node_modules' || dir === '/opt/homebrew/lib/node_modules/@silassolivagus'
    const r = detectInstall(
      '/opt/homebrew/lib/node_modules/@silassolivagus/deepcode/dist/index.js',
      '/opt/homebrew',
      noGit,
      isWritable,
    )
    expect(r.kind).toBe('npm-global')
  })

  it('仓库工作副本内（某级目录有 .git） → dev', () => {
    const hasGit = (dir: string) => dir === '/Users/x/loop/deepcode'
    const r = detectInstall('/Users/x/loop/deepcode/dist/index.js', '/opt/homebrew', hasGit, writable)
    expect(r.kind).toBe('dev')
  })

  it('向上查找 .git 不超过 5 层', () => {
    const hasGit = (dir: string) => dir === '/a'
    // /a/b/c/d/e/f/g/index.js 距 /a 有 7 层 → 不判 dev
    const r = detectInstall('/a/b/c/d/e/f/g/index.js', '/opt/homebrew', hasGit, writable)
    expect(r.kind).toBe('foreign')
  })

  it('pnpm 全局目录 → foreign，给 pnpm 命令', () => {
    const r = detectInstall(
      '/Users/x/Library/pnpm/global/5/node_modules/@silassolivagus/deepcode/dist/index.js',
      '/opt/homebrew',
      noGit,
      writable,
    )
    expect(r.kind).toBe('foreign')
    expect(r.upgradeCommand).toBe('pnpm add -g @silassolivagus/deepcode@latest')
  })

  it('bun 全局目录 → foreign，给 bun 命令', () => {
    const r = detectInstall(
      '/Users/x/.bun/install/global/node_modules/@silassolivagus/deepcode/dist/index.js',
      '/opt/homebrew',
      noGit,
      writable,
    )
    expect(r.kind).toBe('foreign')
    expect(r.upgradeCommand).toBe('bun add -g @silassolivagus/deepcode@latest')
  })

  it('npx 缓存 → foreign，回落通用 npm 命令', () => {
    const r = detectInstall(
      '/Users/x/.npm/_npx/abc123/node_modules/@silassolivagus/deepcode/dist/index.js',
      '/opt/homebrew',
      noGit,
      writable,
    )
    expect(r.kind).toBe('foreign')
    expect(r.upgradeCommand).toBe('npm i -g @silassolivagus/deepcode@latest')
  })

  it('npm prefix 取不到 → foreign，不误判自动升级', () => {
    const r = detectInstall(
      '/opt/homebrew/lib/node_modules/@silassolivagus/deepcode/dist/index.js',
      null,
      noGit,
      writable,
    )
    expect(r.kind).toBe('foreign')
  })

  it('dev 判定优先于 npm-global（仓库里也可能有 node_modules 路径巧合）', () => {
    const hasGit = (dir: string) => dir === '/repo'
    const r = detectInstall('/repo/dist/index.js', '/repo', hasGit, writable)
    expect(r.kind).toBe('dev')
  })

  it('execPath 本身是目录且该目录自身含 .git → dev（回归：process.argv[1] 为空时 realpathSync 静默解析成 cwd 目录）', () => {
    const hasGit = (dir: string) => dir === '/Users/x/loop/deepcode'
    const r = detectInstall('/Users/x/loop/deepcode', '/opt/homebrew', hasGit, writable)
    expect(r.kind).toBe('dev')
  })
})

describe('detectInstall 探测异常不外泄', () => {
  it('isWritable 抛出时按不可写降级为 foreign，而不是把异常抛给调用方', () => {
    const boom = () => { throw new Error('EIO') }
    const r = detectInstall(
      '/opt/homebrew/lib/node_modules/@silassolivagus/deepcode/dist/index.js',
      '/opt/homebrew',
      () => false,
      boom,
    )
    expect(r.kind).toBe('foreign')
    expect(r.upgradeCommand.startsWith('sudo ')).toBe(true)
  })
})
