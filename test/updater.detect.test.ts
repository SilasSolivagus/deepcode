import { describe, it, expect } from 'vitest'
import { detectInstall, PKG } from '../src/updater.js'

const noGit = () => false
const writable = () => true
const notWritable = () => false
/** 默认：带 .git 的那级就是本包的工作副本。 */
const ourPkg = () => PKG

describe('detectInstall', () => {
  it('npm 全局 node_modules 内 + 可写 → npm-global', () => {
    const r = detectInstall(
      '/opt/homebrew/lib/node_modules/@silassolivagus/deepcode/dist/index.js',
      '/opt/homebrew',
      noGit, writable, ourPkg,
    )
    expect(r.kind).toBe('npm-global')
    expect(r.upgradeCommand).toBe('npm i -g @silassolivagus/deepcode@latest')
  })

  it('npm 全局 node_modules 内但不可写（如 sudo npm i -g 装到 root 属主）→ 降级 foreign，命令带 sudo（Bug#5）', () => {
    const r = detectInstall(
      '/opt/homebrew/lib/node_modules/@silassolivagus/deepcode/dist/index.js',
      '/opt/homebrew',
      noGit, notWritable, ourPkg,
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
      noGit, isWritable, ourPkg,
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
      noGit, isWritable, ourPkg,
    )
    expect(r.kind).toBe('npm-global')
  })

  it('仓库工作副本内（某级目录有 .git） → dev', () => {
    const hasGit = (dir: string) => dir === '/Users/x/loop/deepcode'
    const r = detectInstall('/Users/x/loop/deepcode/dist/index.js', '/opt/homebrew', hasGit, writable, ourPkg)
    expect(r.kind).toBe('dev')
  })

  it('向上查找 .git 不超过 5 层', () => {
    const hasGit = (dir: string) => dir === '/a'
    // /a/b/c/d/e/f/g/index.js 距 /a 有 7 层 → 不判 dev
    const r = detectInstall('/a/b/c/d/e/f/g/index.js', '/opt/homebrew', hasGit, writable, ourPkg)
    expect(r.kind).toBe('foreign')
  })

  it('pnpm 全局目录 → foreign，给 pnpm 命令', () => {
    const r = detectInstall(
      '/Users/x/Library/pnpm/global/5/node_modules/@silassolivagus/deepcode/dist/index.js',
      '/opt/homebrew',
      noGit, writable, ourPkg,
    )
    expect(r.kind).toBe('foreign')
    expect(r.upgradeCommand).toBe('pnpm add -g @silassolivagus/deepcode@latest')
  })

  it('bun 全局目录 → foreign，给 bun 命令', () => {
    const r = detectInstall(
      '/Users/x/.bun/install/global/node_modules/@silassolivagus/deepcode/dist/index.js',
      '/opt/homebrew',
      noGit, writable, ourPkg,
    )
    expect(r.kind).toBe('foreign')
    expect(r.upgradeCommand).toBe('bun add -g @silassolivagus/deepcode@latest')
  })

  it('npx 缓存 → foreign，回落通用 npm 命令', () => {
    const r = detectInstall(
      '/Users/x/.npm/_npx/abc123/node_modules/@silassolivagus/deepcode/dist/index.js',
      '/opt/homebrew',
      noGit, writable, ourPkg,
    )
    expect(r.kind).toBe('foreign')
    expect(r.upgradeCommand).toBe('npm i -g @silassolivagus/deepcode@latest')
  })

  it('npm prefix 取不到 → foreign，不误判自动升级', () => {
    const r = detectInstall(
      '/opt/homebrew/lib/node_modules/@silassolivagus/deepcode/dist/index.js',
      null,
      noGit, writable, ourPkg,
    )
    expect(r.kind).toBe('foreign')
  })

  it('dev 判定优先于 npm-global（仓库里也可能有 node_modules 路径巧合）', () => {
    const hasGit = (dir: string) => dir === '/repo'
    const r = detectInstall('/repo/dist/index.js', '/repo', hasGit, writable, ourPkg)
    expect(r.kind).toBe('dev')
  })

  it('execPath 本身是目录且该目录自身含 .git → dev（回归：process.argv[1] 为空时 realpathSync 静默解析成 cwd 目录）', () => {
    const hasGit = (dir: string) => dir === '/Users/x/loop/deepcode'
    const r = detectInstall('/Users/x/loop/deepcode', '/opt/homebrew', hasGit, writable, ourPkg)
    expect(r.kind).toBe('dev')
  })
})

// 「带 .git 的祖先目录」不等于「本包的工作副本」。npm prefix 落在 git 仓库里很常见
// （本机 /opt/homebrew 自身就是 git 仓库；家目录/dotfiles 进 git 的人也不少），
// 只认 .git 会把正经的全局安装误判成 dev → 升级子系统全程静默失效、还不报错。
describe('detectInstall：dev 判定要求那一级确实是本包的工作副本', () => {
  it('全局安装路径的某级恰好有 .git（如 node_modules 被纳入版本管理）→ 不判 dev，仍是 npm-global', () => {
    const hasGit = (dir: string) => dir === '/opt/homebrew/lib/node_modules'
    const r = detectInstall(
      '/opt/homebrew/lib/node_modules/@silassolivagus/deepcode/dist/index.js',
      '/opt/homebrew',
      hasGit, writable, () => null, // 那一级没有本包的 package.json
    )
    expect(r.kind).toBe('npm-global')
  })

  it('带 .git 的那级 package.json 是别的包 → 不判 dev', () => {
    const hasGit = (dir: string) => dir === '/Users/x/someproject'
    const r = detectInstall(
      '/Users/x/someproject/tools/deepcode/dist/index.js',
      null,
      hasGit, writable, () => 'someproject',
    )
    expect(r.kind).toBe('foreign')
  })

  it('外层是别的 git 仓库、内层才是本包工作副本 → 继续向上找，判 dev', () => {
    const hasGit = (dir: string) => dir === '/Users/x/work/deepcode' || dir === '/Users/x/work'
    const pkgNameIn = (dir: string) => (dir === '/Users/x/work/deepcode' ? PKG : 'monorepo-root')
    const r = detectInstall('/Users/x/work/deepcode/dist/index.js', null, hasGit, writable, pkgNameIn)
    expect(r.kind).toBe('dev')
  })

  it('package.json 读不出来（损坏/无权限）→ 保守判非 dev：宁可多提示一次，也不静默失效', () => {
    const hasGit = (dir: string) => dir === '/repo'
    const boom = () => { throw new Error('EACCES') }
    const r = detectInstall('/repo/dist/index.js', null, hasGit, writable, boom)
    expect(r.kind).toBe('foreign')
  })
})

describe('detectInstall 探测异常不外泄', () => {
  it('isWritable 抛出时按不可写降级为 foreign，而不是把异常抛给调用方', () => {
    const boom = () => { throw new Error('EIO') }
    const r = detectInstall(
      '/opt/homebrew/lib/node_modules/@silassolivagus/deepcode/dist/index.js',
      '/opt/homebrew',
      () => false, boom, ourPkg,
    )
    expect(r.kind).toBe('foreign')
    expect(r.upgradeCommand.startsWith('sudo ')).toBe(true)
  })
})
