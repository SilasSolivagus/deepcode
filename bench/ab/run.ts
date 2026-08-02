// A/B 实验跑批器入口。
//
// 用法：npx tsx bench/ab/run.ts bench/ab/experiments/verify-method.yaml [--concurrency 3] [--out DIR]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseDeclaration, declarationHash, type Declaration } from './declaration.js'
import { extractArtifacts } from './artifacts.js'
import { evalObservation } from './predicates.js'
import { buildReport, type RunRecord } from './report.js'

const AB_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEEPCODE_ENTRY = path.join(AB_DIR, '..', '..', 'src', 'index.ts')
const TSX = path.join(AB_DIR, '..', '..', 'node_modules', '.bin', 'tsx')

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** 一次跑：干净 HOME + 空工作目录 + 该臂的 DEEPCODE_FLAGS + 开着请求侧轨迹。 */
async function runOnce(
  decl: Declaration, arm: string, seed: number, outRoot: string, taskbook: string,
): Promise<RunRecord> {
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

  const exitCode: number = await new Promise(resolve => {
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
    child.on('close', code => resolve(code ?? -1))
  })
  fs.closeSync(out); fs.closeSync(err)

  const traceJsonl = fs.readFileSync(tracePath, 'utf8')
  const artifacts = extractArtifacts({ traceJsonl, exitCode, outputDir: work })
  const observations: Record<string, boolean | null> = {}
  for (const o of decl.observations) observations[o.id] = evalObservation(artifacts, o.predicate, o.args)

  return { arm, seed, runDir, artifacts, observations }
}

async function main(): Promise<void> {
  const declPath = process.argv[2]
  if (!declPath) throw new Error('用法：tsx bench/ab/run.ts <声明文件> [--concurrency N] [--out DIR]')
  const yamlText = fs.readFileSync(declPath, 'utf8')
  const decl = parseDeclaration(yamlText)
  const hashBefore = declarationHash(yamlText)

  // 开跑前自检每臂的 flag 取值能被 JSON.stringify/parse 往返——写错了不该跑完才发现
  for (const [arm, flags] of Object.entries(decl.arms)) {
    JSON.parse(JSON.stringify(flags))
    process.stderr.write(`臂 ${arm}: DEEPCODE_FLAGS=${JSON.stringify(flags)}\n`)
  }

  const concurrency = Number(argValue('--concurrency') ?? 3)
  const outRoot = argValue('--out') ?? fs.mkdtempSync(path.join(os.tmpdir(), `ab-${decl.id}-`))
  const taskbook = fs.readFileSync(decl.task.taskbook, 'utf8')
  fs.mkdirSync(outRoot, { recursive: true })

  // 交错排队：baseline, treatment, baseline, treatment, … 而不是先跑完一臂。
  // 机器状态与网络会随时间漂移，交错让漂移在两臂间对称。
  const armNames = Object.keys(decl.arms)
  const queue: Array<{ arm: string; seed: number }> = []
  for (let s = 1; s <= decl.k; s++) for (const arm of armNames) queue.push({ arm, seed: s })

  process.stderr.write(`共 ${queue.length} 次跑，并发 ${concurrency}，产出落 ${outRoot}\n`)

  const records: RunRecord[] = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (next < queue.length) {
      const job = queue[next++]
      process.stderr.write(`▶ ${job.arm}-${job.seed} 开跑\n`)
      // 失败不重跑：某次跑崩了就记状态。重跑会让「失败率」这个信息消失，
      // 而它本身可能就是被测改动的效应。
      records.push(await runOnce(decl, job.arm, job.seed, outRoot, taskbook))
      process.stderr.write(`✔ ${job.arm}-${job.seed} 收工\n`)
    }
  }))

  const hashAfter = declarationHash(fs.readFileSync(declPath, 'utf8'))
  const md = buildReport({ decl, records, hashBefore, hashAfter, outRoot })
  const reportPath = path.join(outRoot, 'report.md')
  fs.writeFileSync(reportPath, md)
  process.stderr.write(`\n报告：${reportPath}\n`)
}

main().catch(e => { process.stderr.write(String(e?.stack ?? e) + '\n'); process.exitCode = 1 })
