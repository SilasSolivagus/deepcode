// 用跑前冻结的考卷给交付物判分。
//
// 为什么必须这么量：从轨迹里推质量这条路走不通——被测机制会改变轨迹的形状。
// 验证子代理实验栽过两次（把测试搬进子代理就白送命中；对照臂结构上没有分母）。
// 不看过程、直接考交付物，才是两臂公平可比的唯一办法。
//
// 三条纪律：
// ① 绝不走考卷自带的 npm test 脚本——它把 --outputFile 写死，并发跑会互相覆盖。
// ② 考卷目录只读；结果写到各次跑自己的目录。
// ③ 装依赖与构建各跑之间互不相干、可并行；跑考卷共用同一个考卷目录，必须串行。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

export interface BuildResult {
  installed: boolean
  built: boolean
  /** 失败时的诊断原文，供人事后看 */
  notes: string
}

export interface FrozenResult extends BuildResult {
  /** 考卷跑完且结果被成功解析出计数。进程崩了/超时/JSON 畸形都记 false */
  scored: boolean
  passed: number
  failed: number
  total: number
}

export type CommandRunner = (
  cmd: string, args: string[],
  opts: { cwd: string; env?: Record<string, string>; timeoutSec: number },
) => { ok: boolean; output: string }

/** 默认实现：真起子进程。测试注入假实现，因此单测不联网、不真的装依赖。 */
const realRun: CommandRunner = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    timeout: opts.timeoutSec * 1000,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`
  return { ok: r.status === 0, output }
}

/** 只留末尾若干字符——诊断够用，又不至于把整份构建日志灌进报告。 */
function tail(s: string, n = 2000): string {
  return s.length <= n ? s : s.slice(-n)
}

/** 解析 vitest 的 JSON 报告。字段名实读自 #6 评测留下的真实产物
 *  （eval-6/report/r1-result.json：numTotalTests=46 / numPassedTests=12 / numFailedTests=34）。
 *  总数为 0 也记 scored=false：一道都没跑不该被当成「全过」。 */
export function parseFrozenReport(raw: string): { scored: boolean; passed: number; failed: number; total: number } {
  const none = { scored: false, passed: 0, failed: 0, total: 0 }
  let d: any
  try { d = JSON.parse(raw) } catch { return none }
  const total = d?.numTotalTests, passed = d?.numPassedTests, failed = d?.numFailedTests
  if (typeof total !== 'number' || typeof passed !== 'number' || typeof failed !== 'number') return none
  if (total <= 0) return none
  return { scored: true, passed, failed, total }
}

/** 阶段一二：装依赖 + 构建。各次跑互不相干，可并行调用。
 *  构建方式由任务书硬性规定（eval-6/TASKBOOK.md:5-6：npm install && npm run build → dist/cli.js），
 *  不随产出物变，因此可以写死。 */
export function buildArtifact(input: {
  workDir: string
  timeoutSec?: { install?: number; build?: number }
  run?: CommandRunner
}): BuildResult {
  const run = input.run ?? realRun
  const t = input.timeoutSec ?? {}
  const ins = run('npm', ['install'], { cwd: input.workDir, timeoutSec: t.install ?? 600 })
  if (!ins.ok) return { installed: false, built: false, notes: `install 失败：\n${tail(ins.output)}` }
  const bld = run('npm', ['run', 'build'], { cwd: input.workDir, timeoutSec: t.build ?? 300 })
  if (!bld.ok) return { installed: true, built: false, notes: `build 失败：\n${tail(bld.output)}` }
  return { installed: true, built: true, notes: '' }
}

/** 阶段三：用冻结考卷判分。多次跑共用同一个 harnessDir，**必须串行调用**。
 *  考卷有失败时 vitest 退出码非零——那不是「没跑」，仍要解析计数，所以不看 ok 只看结果文件。 */
export function runFrozenTests(input: {
  workDir: string
  harnessDir: string
  outputFile: string
  build: BuildResult
  timeoutSec?: number
  run?: CommandRunner
  readFile?: (p: string) => string
}): FrozenResult {
  const base = { ...input.build, scored: false, passed: 0, failed: 0, total: 0 }
  // 构建没成，产出物里没有 dist/cli.js，跑考卷没有意义
  if (!input.build.built) return base
  const run = input.run ?? realRun
  const readFile = input.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'))
  // 直接调 vitest 并显式给绝对路径的 --outputFile：绝不走考卷自带的 npm test
  // （那个脚本把路径写死成 ../report/raw-result.json，并发跑会互相覆盖）。
  const r = run('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${input.outputFile}`], {
    cwd: input.harnessDir,
    env: { LOGSTAT_DIR: input.workDir },
    timeoutSec: input.timeoutSec ?? 600,
  })
  let raw: string
  try { raw = readFile(input.outputFile) } catch {
    return { ...base, notes: `${input.build.notes}考卷结果读不到：\n${tail(r.output)}` }
  }
  const parsed = parseFrozenReport(raw)
  return { ...input.build, ...parsed }
}
