// src/updater.ts
// 自动升级子系统：版本比较、安装形态检测、节流闸、状态机、编排。
// 纯逻辑与副作用分离——副作用（网络/子进程/文件）全部经 deps 注入，便于单测。
// 安全：包名为模块常量；升级命令固定 argv 数组，registry 返回的字符串绝不进命令行。

import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'

/** npm 包名。硬编码常量，不从任何配置读取（杜绝注入面）。 */
export const PKG = '@silassolivagus/deepcode'

/** 版本检查节流间隔：24 小时。 */
export const CHECK_INTERVAL_MS = 86_400_000

/** 解析 x.y.z（忽略 +build 后缀）；含预发布标记或格式非法 → null。 */
function parseVersion(v: string): [number, number, number] | null {
  if (typeof v !== 'string') return null
  const core = v.split('+')[0].trim()
  if (core.includes('-')) return null // 预发布版：保守不参与比较
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(core)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** semver 比较。忽略 +build；任一侧预发布或非法 → 0（判为「不升级」）。 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a), pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1
    if (pa[i] < pb[i]) return -1
  }
  return 0
}

/** 节流状态（落 ~/.deepcode/update.json）。 */
export interface UpdateCheckState { lastCheckAt: number; latest?: string }

/** 距上次检查是否已超过间隔。state 缺失/损坏/时间戳非法 → true。 */
export function shouldCheck(state: UpdateCheckState | null, now: number, intervalMs = CHECK_INTERVAL_MS): boolean {
  if (!state) return true
  const last = state.lastCheckAt
  if (typeof last !== 'number' || !Number.isFinite(last) || last <= 0 || last > now) return true
  return now - last >= intervalMs
}

export type InstallKind = 'npm-global' | 'foreign' | 'dev'
export interface InstallInfo {
  kind: InstallKind
  /** 展示给用户的升级命令文本（非执行用；执行永远走固定 argv 数组）。 */
  upgradeCommand: string
}

/** 升级状态。upgraded/failed/up-to-date/check-failed 是终态，本次会话内不再变化。 */
export type UpdateStatus =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'available'; latest: string; command: string }
  | { phase: 'upgrading'; latest: string }
  | { phase: 'upgraded'; latest: string }
  | { phase: 'failed'; command: string }
  | { phase: 'up-to-date'; latest: string }
  | { phase: 'check-failed' }

/** 页脚文案。过程态返回 null（不渲染，避免开场闪烁）。 */
export function formatUpdateStatus(s: UpdateStatus): string | null {
  switch (s.phase) {
    case 'upgraded': return `✦ 已升至 ${s.latest} · 重启生效`
    case 'available': return `✦ 有新版 ${s.latest} · ${s.command}`
    case 'failed': return `✦ 升级失败 · ${s.command}`
    default: return null
  }
}

const on = (v: string | undefined): boolean => !!v && v !== '0' && v !== 'false'

/** 全关开关：不查询、不提示、/update 直接拒。 */
export function updatesDisabled(env: NodeJS.ProcessEnv): boolean {
  return on(env.DEEPCODE_DISABLE_UPDATES)
}

/** 是否允许后台自动升级（仍会检查与提示）。 */
export function autoUpgradeAllowed(env: NodeJS.ProcessEnv, autoUpdates: boolean | undefined): boolean {
  if (updatesDisabled(env)) return false
  if (on(env.DEEPCODE_DISABLE_AUTOUPDATER)) return false
  return autoUpdates !== false
}

const NPM_CMD = `npm i -g ${PKG}@latest`

/** 判定当前运行副本的安装形态。execPath 应为已解符号链接的绝对路径。
 *  isWritable 只在判出 npm-global 时用来复核安装目录是否真的可写
 *  （sudo npm i -g 装到 root 属主的目录时，普通用户进程判成 npm-global 却写不动，会
 *  一直静默重试 EACCES；不可写就降级成 foreign，提示带 sudo 的命令，只提示不碰磁盘）。 */
export function detectInstall(
  execPath: string,
  npmPrefix: string | null,
  hasGitDir: (dir: string) => boolean,
  isWritable: (dir: string) => boolean,
): InstallInfo {
  const p = path.resolve(execPath)
  // 1) dev：从自身开始逐级向上最多 5 层，任一级有 .git → 仓库工作副本，完全静默
  //    从 p 自身起步（而非 path.dirname(p)）：execPath 若解析成目录本身（如 process.argv[1]
  //    为空时 fs.realpathSync('') 静默落成 cwd），不能被 dirname 跳过而漏检。
  //    对正常的文件路径，这只是多一次必然为 false 的无害检查。
  let dir = p
  for (let i = 0; i < 5; i++) {
    try { if (hasGitDir(dir)) return { kind: 'dev', upgradeCommand: NPM_CMD } } catch { /* 探测失败当作没有 */ }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // 2) npm-global：落在 <prefix>/lib/node_modules/<PKG>/ 内。
  //    （Windows 上 npm 就是 npm.cmd；Node ≥18.20/20.12 起不带 shell:true 无法 spawn .cmd，
  //     npmPrefix() 在 Windows 恒为 null，本分支天然走不到——自动升级路径目前不支持 Windows，
  //     安全降级为只提示，故这里不再判 Windows 专属子路径，避免误导性死代码。）
  if (npmPrefix) {
    const posix = path.join(npmPrefix, 'lib', 'node_modules', PKG) + path.sep
    if (p.startsWith(posix)) {
      if (isWritable(npmPrefix)) return { kind: 'npm-global', upgradeCommand: NPM_CMD }
      return { kind: 'foreign', upgradeCommand: `sudo ${NPM_CMD}` }
    }
  }
  // 3) foreign：按路径线索给对应包管理器命令，判不出回落通用 npm
  if (p.includes(`${path.sep}pnpm${path.sep}`)) return { kind: 'foreign', upgradeCommand: `pnpm add -g ${PKG}@latest` }
  if (p.includes(`${path.sep}.bun${path.sep}`)) return { kind: 'foreign', upgradeCommand: `bun add -g ${PKG}@latest` }
  return { kind: 'foreign', upgradeCommand: NPM_CMD }
}

const STATE_FILE = 'update.json'
const LOCK_FILE = 'update.lock'
const LOCK_FRESH_MS = 600_000 // 10 分钟

/** 读节流状态；无文件/损坏 → null。 */
export function readUpdateState(dir: string): UpdateCheckState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'))
    if (!raw || typeof raw.lastCheckAt !== 'number') return null
    return { lastCheckAt: raw.lastCheckAt, latest: typeof raw.latest === 'string' ? raw.latest : undefined }
  } catch { return null }
}

/** 写节流状态；失败静默（只损失一次节流）。 */
export function writeUpdateState(dir: string, s: UpdateCheckState): void {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(s))
  } catch { /* 忽略 */ }
}

function pidAliveDefault(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** 抢升级锁：持有者进程存活且锁未过期 → false。写锁失败 → false（宁可不升也不并发跑 npm）。 */
export function tryAcquireUpdateLock(
  dir: string, now: number, isPidAlive: (pid: number) => boolean = pidAliveDefault,
): boolean {
  const p = path.join(dir, LOCK_FILE)
  try {
    const stat = fs.statSync(p)
    const pid = parseInt(fs.readFileSync(p, 'utf8').trim(), 10)
    if (Number.isFinite(pid) && isPidAlive(pid) && now - stat.mtimeMs < LOCK_FRESH_MS) return false
    // 锁已过期或持有者已死：清掉旧锁，下面走排他创建
    try { fs.rmSync(p, { force: true }) } catch { /* 忽略 */ }
  } catch { /* 无锁/读不出 → 可抢占，继续走排他创建 */ }
  try {
    fs.mkdirSync(dir, { recursive: true })
    // 'wx'：排他创建，文件已存在则抛 EEXIST——堵住"判定可抢占"与"写入"之间的竞态窗口
    fs.writeFileSync(p, String(process.pid), { flag: 'wx' })
    fs.utimesSync(p, new Date(now), new Date(now)) // mtime 与调用方时间尺度对齐
    return true
  } catch { return false }
}

/** 释放升级锁：只删自己持有的锁；不是自己的（已被别的进程重新抢占）→ 不删，留给过期机制回收。失败静默。 */
export function releaseUpdateLock(dir: string): void {
  const p = path.join(dir, LOCK_FILE)
  try {
    const pid = parseInt(fs.readFileSync(p, 'utf8').trim(), 10)
    if (pid !== process.pid) return
    fs.rmSync(p, { force: true })
  } catch { /* 忽略：读不出/无文件 */ }
}

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const UPGRADE_TIMEOUT_MS = 300_000 // 5 分钟

/** 解析 registry：尊重用户 npm 配置（国内镜像），强制 http/https 白名单，异常回落官方源。 */
export function resolveRegistry(readNpmConfig: () => string | null): string {
  try {
    const raw = (readNpmConfig() ?? '').trim()
    if (!raw) return DEFAULT_REGISTRY
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return DEFAULT_REGISTRY
    return raw.replace(/\/+$/, '')
  } catch { return DEFAULT_REGISTRY }
}

/** 版本号白名单：不匹配即视为不可信（可能是恶意 registry 塞入的控制字符/超长串），拒绝落盘与展示。 */
const VERSION_WHITELIST_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][\w.-]{0,64})?$/
const MAX_RESPONSE_BYTES = 64 * 1024

/** 查最新版本号；任何失败静默返回 null。 */
export async function fetchLatest(
  registry: string, timeoutMs = 3000, doFetch: typeof fetch = fetch,
): Promise<string | null> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    // redirect:'error'：恶意 registry 可能把响应重定向到内网地址，绝不跟随
    const res = await doFetch(`${registry}/${PKG}/latest`, { signal: ac.signal, redirect: 'error' })
    if (!res.ok) return null
    const text = await res.text()
    if (text.length > MAX_RESPONSE_BYTES) return null // 恶意超大响应体，拒绝解析
    let body: any
    try { body = JSON.parse(text) } catch { return null }
    const v = body?.version
    if (typeof v !== 'string') return null
    return VERSION_WHITELIST_RE.test(v) ? v : null
  } catch { return null } finally { clearTimeout(timer) }
}

export type SpawnLike = (cmd: string, args: string[], opts: { stdio: 'ignore' }) => {
  on(ev: 'close' | 'error', cb: (arg: number | Error) => void): void
  kill(): void
}

/** 跑 npm 全局升级。固定 argv 数组，无 shell，无字符串拼接。成功 → true。 */
export async function runUpgrade(spawnFn: SpawnLike, timeoutMs = UPGRADE_TIMEOUT_MS): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (ok: boolean) => { if (!done) { done = true; if (timer) clearTimeout(timer); resolve(ok) } }
    try {
      const child = spawnFn('npm', ['i', '-g', `${PKG}@latest`], { stdio: 'ignore' })
      timer = setTimeout(() => { try { child.kill() } catch { /* 忽略 */ } finish(false) }, timeoutMs)
      child.on('close', (code: number | Error) => finish(code === 0))
      child.on('error', () => finish(false))
    } catch { finish(false) }
  })
}

export interface UpdaterDeps {
  /** 状态与锁所在目录（生产传 ~/.deepcode）。 */
  dir: string
  env: NodeJS.ProcessEnv
  now: () => number
  currentVersion: string
  install: InstallInfo
  autoUpdates: boolean | undefined
  registry: string
  fetchLatest: (registry: string) => Promise<string | null>
  runUpgrade: () => Promise<boolean>
  onStatus: (s: UpdateStatus) => void
  /** true = 绕过 24h 节流（/update 手动触发）。 */
  force?: boolean
}

/** 查 npm 全局 prefix；失败 → null（则不判 npm-global，退化为只提示）。 */
function npmPrefix(): string | null {
  try {
    return execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch { return null }
}

/** 读 npm 配置的 registry；失败 → null（则回落官方源）。
 *  必须带 -g：不带 -g 时 execFileSync 继承 process.cwd()，若该目录（用户打开的仓库）带恶意
 *  .npmrc 的 registry 字段，会被劫持——我们做的是全局安装，语义上也该查全局 registry。 */
function npmRegistry(): string | null {
  try {
    return execFileSync('npm', ['config', 'get', 'registry', '-g'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch { return null }
}

function defaultHasGitDir(dir: string): boolean {
  try { return fs.existsSync(path.join(dir, '.git')) } catch { return false }
}

function currentExecPath(): string {
  let execPath = process.argv[1] ?? ''
  try { execPath = fs.realpathSync(execPath) } catch { /* 保留原值 */ }
  return execPath
}

/** 零子进程的安装形态粗判：只用 fs 检查，不查 npm prefix（传 null）。npm-global 因缺 prefix
 *  判不出、会归到 foreign（但 foreign 的通用命令与 npm-global 的命令文本相同，不影响展示）。
 *  用于「只是要展示提示文案，不需要精确到能否自动升级」的零成本场景（节流命中时的展示/
 *  /update 命令里判断 dev 是否要静默）——真要精确判定 npm-global 仍须走 createUpdaterDeps。 */
export function detectInstallCheap(): InstallInfo {
  return detectInstall(currentExecPath(), null, defaultHasGitDir, () => false)
}

/** 组装生产用 deps：解析安装形态与 registry，绑定真实 fetch/spawn。不产生任何可见副作用。 */
export function createUpdaterDeps(o: {
  dir: string
  currentVersion: string
  autoUpdates: boolean | undefined
  onStatus: (s: UpdateStatus) => void
  force?: boolean
}): UpdaterDeps {
  // 先用零子进程的粗判（传 null prefix，detectInstall 不会判出 npm-global）——
  // 命中 dev 就直接返回，一次子进程都不跑。只有非 dev 才值得花两次 execFileSync 去探
  // npm prefix/registry；此时须用真实 prefix 重新判定形态，才能正确识别 npm 全局安装。
  let install = detectInstallCheap()
  let registry = DEFAULT_REGISTRY
  if (install.kind !== 'dev') {
    const isWritable = (dir: string): boolean => {
      try { fs.accessSync(dir, fs.constants.W_OK); return true } catch { return false }
    }
    install = detectInstall(currentExecPath(), npmPrefix(), defaultHasGitDir, isWritable)
    registry = resolveRegistry(npmRegistry)
  }
  return {
    dir: o.dir,
    env: process.env,
    now: () => Date.now(),
    currentVersion: o.currentVersion,
    install,
    autoUpdates: o.autoUpdates,
    registry,
    fetchLatest: reg => fetchLatest(reg),
    runUpgrade: () => runUpgrade(spawn as unknown as SpawnLike),
    onStatus: o.onStatus,
    force: o.force,
  }
}

/** 编排：节流闸 → 查询 → 比较 → 自动升级/仅提示。全程 fail-safe，绝不抛出。 */
export async function startUpdateCheck(deps: UpdaterDeps): Promise<void> {
  // settled：一旦发出过 'checking' 以外的状态，外层 catch 就不再把它回滚成 idle
  // （Bug#7：消费端处理某个已发出状态时抛出，不该把页脚已展示的内容抹掉）。
  let settled = false
  const emit = (s: UpdateStatus): void => {
    if (s.phase !== 'checking') settled = true
    deps.onStatus(s)
  }
  try {
    if (updatesDisabled(deps.env)) return
    if (deps.install.kind === 'dev') return
    const now = deps.now()
    const state = readUpdateState(deps.dir)
    if (!deps.force && !shouldCheck(state, now)) {
      // 节流命中：不联网、不升级，只在缓存里已知有更新时才提示（Bug#3：此前直接 return 会把
      // 「有新版」的提示整个吞掉——pnpm/bun/foreign 等只提示形态一天只有一次机会看到它）
      if (state?.latest && compareVersions(state.latest, deps.currentVersion) === 1) {
        emit({ phase: 'available', latest: state.latest, command: deps.install.upgradeCommand })
      }
      return
    }

    emit({ phase: 'checking' })
    const latest = await deps.fetchLatest(deps.registry)
    if (!latest) { emit({ phase: 'check-failed' }); return }
    writeUpdateState(deps.dir, { lastCheckAt: now, latest })
    if (compareVersions(latest, deps.currentVersion) !== 1) { emit({ phase: 'up-to-date', latest }); return }

    const canAuto = deps.install.kind === 'npm-global' && autoUpgradeAllowed(deps.env, deps.autoUpdates)
    const available: UpdateStatus = { phase: 'available', latest, command: deps.install.upgradeCommand }
    if (!canAuto) { emit(available); return }

    if (!tryAcquireUpdateLock(deps.dir, now)) { emit(available); return }
    try {
      emit({ phase: 'upgrading', latest })
      let ok = false
      try { ok = await deps.runUpgrade() } catch { ok = false }
      emit(ok ? { phase: 'upgraded', latest } : { phase: 'failed', command: deps.install.upgradeCommand })
    } finally {
      releaseUpdateLock(deps.dir)
    }
  } catch {
    // 任何意外都不影响会话；但已发出过有意义状态的不再回滚成 idle（Bug#7）
    if (!settled) {
      try { deps.onStatus({ phase: 'idle' }) } catch { /* 忽略 */ }
    }
  }
}
