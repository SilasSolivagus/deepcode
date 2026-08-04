// A/B 实验跑批器入口。
//
// 用法：npx tsx bench/ab/run.ts bench/ab/experiments/verify-method.yaml [--concurrency 3] [--timeout 1800] [--out DIR]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseDeclaration, declarationHash, type Declaration } from './declaration.js'
import { extractArtifacts } from './artifacts.js'
import { evalObservation } from './predicates.js'
import { buildReport, type RunRecord } from './report.js'
import { buildArtifact, runFrozenTests, type BuildResult, type FrozenResult } from './frozenHarness.js'

interface PendingRun {
  arm: string
  seed: number
  runDir: string
  work: string
  traceDir: string
  traceJsonl: string
  exitCode: number
  build: BuildResult
}

const AB_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEEPCODE_ENTRY = path.join(AB_DIR, '..', '..', 'src', 'index.ts')
const TSX = path.join(AB_DIR, '..', '..', 'node_modules', '.bin', 'tsx')

/** 取 `--name <值>`。传了参数名却没给值就抛错——「漏打取值」与「压根没传」必须分开：
 *  前者静默回落到默认值会让人以为自己设了 `--concurrency 1`、实际按 3 并发烧钱。
 *  取值以 `-` 开头同样报错，免得把后一个参数名当成取值吞掉（`--out --concurrency 3`）。 */
function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  if (i < 0) return undefined
  const v = process.argv[i + 1]
  if (v === undefined || v.length === 0 || v.startsWith('-')) throw new Error(`${name} 需要一个取值`)
  return v
}

/** 正整数命令行参数。写错（非数字、0、负数、小数）就直接抛错退出，不静默降级——
 *  静默降级会导致 `--concurrency abc` 这类输入被 `Number()`/`Math.min` 一路吃成 NaN，
 *  最终跑出零次真实调用却以 exit 0「成功」收场，只在 stderr 留一行容易被忽略的日志。 */
function positiveIntArg(name: string, def: number): number {
  const raw = argValue(name)
  if (raw === undefined) return def
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    throw new Error(`${name} 必须是正整数，收到：${JSON.stringify(raw)}`)
  }
  return Number(raw)
}

/** 一次跑：干净 HOME + 空工作目录 + 该臂的 DEEPCODE_FLAGS + 开着请求侧轨迹。 */
async function runOnce(
  decl: Declaration, arm: string, seed: number, outRoot: string, taskbook: string, timeoutSec: number,
): Promise<PendingRun> {
  const runDir = path.join(outRoot, `${arm}-${seed}`)
  const home = path.join(runDir, 'home')
  const work = path.join(runDir, 'work')
  const traceDir = path.join(runDir, 'trace')
  fs.mkdirSync(path.join(home, '.deepcode'), { recursive: true })
  fs.mkdirSync(work, { recursive: true })
  // 干净 HOME：deepcode 的配置根写死在 os.homedir()，不换 HOME 就会吃到用户的全局记忆、
  // 全局指令、自定义技能——两臂之间倒是对称，但结果不可复现。
  fs.writeFileSync(
    path.join(home, '.deepcode', 'settings.json'),
    JSON.stringify({ provider: 'deepseek', model: 'deepseek-v4-pro' }),
    { mode: 0o600 },
  )

  const tracePath = path.join(runDir, 'stream.jsonl')
  const out = fs.openSync(tracePath, 'w')
  const err = fs.openSync(path.join(runDir, 'stderr.log'), 'w')

  let exitCode: number
  try {
    exitCode = await new Promise(resolve => {
      const child = spawn(TSX, [DEEPCODE_ENTRY, '-p', taskbook, '--output-format', 'stream-json', '--yolo'], {
        cwd: work,
        stdio: ['ignore', out, err],
        env: {
          ...process.env,
          HOME: home,
          DEEPCODE_FLAGS: JSON.stringify(decl.arms[arm]),
          DEEPCODE_TRACE_DIR: traceDir,
        },
      })
      let settled = false
      // 无监听者的 'error' 事件会被 Node 当未捕获异常抛出，直接终止整个跑批进程——
      // 已经跑完、已经花了钱的记录会随之全部作废（它们只活在内存的 records 数组里，
      // report.md 要等 Promise.all 全部完成后才写盘）。监听它、resolve 一个哨兵退出码，
      // 让这次跑作为一条失败记录正常流进 records，而不是拖垮整个批次。
      child.on('error', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(-1)
      })
      // 挂死的子进程（模型不返回、死循环）不会触发 'close'，会永久占住一个并发槽位；
      // 挂满并发数会让 Promise.all 永不 resolve，report.md 永远写不出来。超时后强杀，
      // 同样 resolve 一个哨兵退出码（124，与 GNU timeout 一致）而不是让批次挂死。
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        resolve(124)
      }, timeoutSec * 1000)
      child.on('close', code => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(code ?? -1)
      })
    })
  } finally {
    // try/finally：即便上面的 Promise 抛出异常，两个已打开的 fd 也不能漏关。
    fs.closeSync(out); fs.closeSync(err)
  }

  const traceJsonl = fs.readFileSync(tracePath, 'utf8')
  // 装依赖 + 构建就地做：各次跑互不相干，跟着跑批的并发一起并行。
  // 跑考卷不在这里——那要共用同一个只读考卷目录，必须串行（见下方第二段）。
  process.stderr.write(`  ${arm}-${seed} 构建交付物…\n`)
  const build = buildArtifact({ workDir: work })
  if (!build.built) process.stderr.write(`  ⚠ ${arm}-${seed} 构建未成功，考卷将记为失败\n`)

  return { arm, seed, runDir, work, traceDir, traceJsonl, exitCode, build }
}

async function main(): Promise<void> {
  const declPath = process.argv[2]
  if (!declPath) throw new Error('用法：tsx bench/ab/run.ts <声明文件> [--concurrency N] [--timeout SEC] [--out DIR]')
  const yamlText = fs.readFileSync(declPath, 'utf8')
  const decl = parseDeclaration(yamlText)
  const hashBefore = declarationHash(yamlText)

  // 开跑前自检每臂的 flag 取值能被 JSON.stringify/parse 往返——写错了不该跑完才发现
  for (const [arm, flags] of Object.entries(decl.arms)) {
    JSON.parse(JSON.stringify(flags))
    process.stderr.write(`臂 ${arm}: DEEPCODE_FLAGS=${JSON.stringify(flags)}\n`)
  }

  const concurrency = positiveIntArg('--concurrency', 3)
  const timeoutSec = positiveIntArg('--timeout', 1800)
  const outRoot = argValue('--out') ?? fs.mkdtempSync(path.join(os.tmpdir(), `ab-${decl.id}-`))
  const taskbook = fs.readFileSync(decl.task.taskbook, 'utf8')
  fs.mkdirSync(outRoot, { recursive: true })

  // 交错排队：baseline, treatment, baseline, treatment, … 而不是先跑完一臂。
  // 机器状态与网络会随时间漂移，交错让漂移在两臂间对称。
  const armNames = Object.keys(decl.arms)
  const queue: Array<{ arm: string; seed: number }> = []
  for (let s = 1; s <= decl.k; s++) for (const arm of armNames) queue.push({ arm, seed: s })

  process.stderr.write(`共 ${queue.length} 次跑，并发 ${concurrency}，产出落 ${outRoot}\n`)

  // 第一段：并发跑，每次跑完就地装依赖 + 构建
  const pending: PendingRun[] = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (next < queue.length) {
      const job = queue[next++]
      process.stderr.write(`▶ ${job.arm}-${job.seed} 开跑\n`)
      // 失败不重跑：某次跑崩了就记状态。重跑会让「失败率」这个信息消失，
      // 而它本身可能就是被测改动的效应。
      pending.push(await runOnce(decl, job.arm, job.seed, outRoot, taskbook, timeoutSec))
      process.stderr.write(`✔ ${job.arm}-${job.seed} 收工\n`)
    }
  }))

  // 第二段：串行跑冻结考卷。多次跑共用同一个考卷目录，vitest/vite 的缓存在并发下会打架。
  // 考卷目录只读——结果写到各次跑自己的目录里。
  process.stderr.write(`\n开始用冻结考卷判分（串行，共 ${pending.length} 次）\n`)
  const records: RunRecord[] = []
  for (const p of pending) {
    process.stderr.write(`  ${p.arm}-${p.seed} 判分…\n`)
    const frozen = runFrozenTests({
      workDir: p.work,
      harnessDir: decl.task.harness,
      outputFile: path.join(p.runDir, 'frozen-result.json'),
      build: p.build,
    })
    if (frozen.notes) fs.writeFileSync(path.join(p.runDir, 'frozen-notes.txt'), frozen.notes)
    process.stderr.write(
      `  ${p.arm}-${p.seed} → ${frozen.scored ? `${frozen.passed}/${frozen.total}` : '未判分'}\n`,
    )
    const artifacts = extractArtifacts({
      traceJsonl: p.traceJsonl, exitCode: p.exitCode, outputDir: p.work, traceDir: p.traceDir, frozen,
    })
    // I7：'na'（本次跑不适用）与 'error'（判定器不存在/抛异常）分开，别再混成一个 null。
    const observations: Record<string, boolean | 'na' | 'error'> = {}
    for (const o of decl.observations) observations[o.id] = evalObservation(artifacts, o.predicate, o.args)
    records.push({ arm: p.arm, seed: p.seed, runDir: p.runDir, artifacts, observations })
  }

  const hashAfter = declarationHash(fs.readFileSync(declPath, 'utf8'))
  // 防篡改：声明文件若在跑动中途被改（正则、expect 被悄悄改动），这里必须自己报警——
  // 不能指望展示层会做这件事。报告怎么呈现是下一个任务的事，但执行器自己先要喊出来。
  if (hashBefore !== hashAfter) {
    process.stderr.write(
      `\n⚠️ 警告：声明文件在跑动过程中被修改（hashBefore=${hashBefore} hashAfter=${hashAfter}）。` +
      `本次报告的判据可能与实际跑动时不一致，结果不可信。\n`,
    )
    process.exitCode = 1
  }
  const md = buildReport({ decl, records, hashBefore, hashAfter, outRoot })
  const reportPath = path.join(outRoot, 'report.md')
  fs.writeFileSync(reportPath, md)
  process.stderr.write(`\n报告：${reportPath}\n`)
}

main().catch(e => { process.stderr.write(String(e?.stack ?? e) + '\n'); process.exitCode = 1 })
