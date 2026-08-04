// 用跑前冻结的考卷给交付物判分。
//
// 为什么必须这么量：从轨迹里推质量这条路走不通——被测机制会改变轨迹的形状。
// 验证子代理实验栽过两次（把测试搬进子代理就白送命中；对照臂结构上没有分母）。
// 不看过程、直接考交付物，才是两臂公平可比的唯一办法。
//
// 三条纪律：
// ① 绝不走考卷自带的 npm test 脚本——它把 --outputFile 写死，并发跑会互相覆盖。
// ② 考卷的受冻结文件不得被写入；vitest 自身的 node_modules/.vite 缓存会被改写，
//    它不在冻结清单内，不影响判分——结果另外写到各次跑自己的目录。
// ③ 构建（装依赖 + npm run build）与跑考卷都用 spawnSync 实现，同步阻塞整个 Node
//    事件循环——两者都不与其它跑重叠，必须串行调用（调用方：run.ts 第二段的 for 循环）。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

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
  // spawnSync 拿不到可执行文件（如 npm 不在 PATH）时 stdout/stderr 都是 null，
  // 错误只在 r.error 里；被信号杀掉（如超时）时 r.signal 有值而 stdout/stderr 可能也是空的。
  // 两者都不带出来，notes 就会是空字符串——诊断在最该有用的时候归零。
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n[spawn 失败] ${r.error.message}` : ''}${r.signal ? `\n[被信号终止] ${r.signal}（可能是超时）` : ''}`
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

/** 阶段一二：装依赖 + 构建。用 spawnSync 实现，同步阻塞整个 Node 事件循环——
 *  调用方不得把它放进并发段（会让「并行」构建实际排成串行，还会推迟其它并发跑里
 *  定时器的触发），必须在串行阶段逐个调用。
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
  // 读到了文件但解析不出计数（JSON 畸形/缺字段/字段类型不对）：不能悄悄走成功路径——
  // notes 沿用 input.build.notes（构建成功时是空串），下游 run.ts 靠 notes 非空才落盘
  // frozen-notes.txt，诊断会在最需要的时候消失，还把这次明确的判分失败误记成「没数据」。
  if (!parsed.scored) {
    return { ...input.build, ...parsed, notes: `${input.build.notes}考卷结果解析不出计数：\n${tail(raw, 500)}\n${tail(r.output)}` }
  }
  return { ...input.build, ...parsed }
}

/** 校验冻结清单（FROZEN.txt）列出的文件哈希是否与磁盘一致。跑批器在串行判分开始前调一次。
 *
 *  FROZEN.txt 开头三行是中文说明（冻结时间/分层条数/备注），真正的「哈希  路径」记录从
 *  `---` 分隔行之后才开始——不能把整份文件直接喂给 `shasum -c`，得先按 `---` 切开。
 *  这与 eval-6/verify-frozen.sh 的做法一致：
 *  `sed -n '/^---$/,$p' FROZEN.txt | tail -n +2 | shasum -a 256 -c -`。
 *  路径是相对 FROZEN.txt 所在目录写的，cwd 因此取该目录。 */
export function verifyFrozenManifest(input: {
  frozenPath: string
  readFile?: (p: string) => string
  /** 注入点：真实实现起 `shasum -a 256 -c -`，把清单正文喂进 stdin。 */
  run?: (cmd: string, args: string[], opts: { cwd: string; input: string; timeoutSec: number }) => { ok: boolean; output: string }
}): { ok: boolean; output: string } {
  const readFile = input.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'))
  const run = input.run ?? ((cmd, args, opts) => {
    const r = spawnSync(cmd, args, {
      cwd: opts.cwd,
      input: opts.input,
      encoding: 'utf8',
      timeout: opts.timeoutSec * 1000,
      maxBuffer: 32 * 1024 * 1024,
    })
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n[spawn 失败] ${r.error.message}` : ''}`
    return { ok: r.status === 0, output }
  })

  let raw: string
  try { raw = readFile(input.frozenPath) } catch (e) {
    return { ok: false, output: `冻结清单读不到：${input.frozenPath}\n${String((e as Error)?.message ?? e)}` }
  }
  const lines = raw.split('\n')
  const sepIndex = lines.findIndex(l => l === '---')
  if (sepIndex < 0) {
    return { ok: false, output: `冻结清单格式不对：找不到 "---" 分隔行，无法定位哈希记录起点\n${tail(raw, 500)}` }
  }
  const manifestBody = lines.slice(sepIndex + 1).join('\n')
  const r = run('shasum', ['-a', '256', '-c', '-'], {
    cwd: path.dirname(input.frozenPath),
    input: manifestBody,
    timeoutSec: 60,
  })
  return { ok: r.ok, output: r.output }
}
