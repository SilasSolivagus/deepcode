// deepcode eval harness · 编排器
// 用法：node eval/run.mjs [--models a,b,c] [--seeds N] [--scenarios id,id] [--out file.json]
// 每格：模型 × 场景 × seed → 隔离 HOME 跑 deepcode headless --yolo → 程序化判分。
// 报告：pass^N（N 次全过=可靠）/ passN / 平均 turns·成本·耗时。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { SCENARIOS, genAccessLog } from './scenarios.mjs'

const DC = process.env.DC_BIN || '/Users/silas/loop/deepcode/dist/index.js'
const ROOT = path.join(os.homedir(), 'dc-eval-runs')
const REAL_SETTINGS = path.join(os.homedir(), '.deepcode', 'settings.json')

// ---- argv ----
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d }
const MODELS = arg('--models', 'deepseek-v4-pro,deepseek-v4-flash,glm-5-turbo').split(',')
const SEEDS = Number(arg('--seeds', '3'))
const ONLY = arg('--scenarios', '')
const OUT = arg('--out', path.join(ROOT, 'results.json'))
const scenarios = ONLY ? SCENARIOS.filter(s => ONLY.split(',').includes(s.id)) : SCENARIOS

const providerOf = (m) => m.startsWith('glm') ? 'glm' : 'deepseek'
const assets = { accessLog: genAccessLog() }

// 每个模型一个隔离 HOME（settings 钉 provider+model+关记忆）
function homeFor(model) {
  const H = path.join(ROOT, '_home-' + model)
  fs.rmSync(H, { recursive: true, force: true })
  fs.mkdirSync(path.join(H, '.deepcode'), { recursive: true })
  const s = JSON.parse(fs.readFileSync(REAL_SETTINGS, 'utf8'))
  s.provider = providerOf(model); s.model = model; s.memory = { enabled: false }
  fs.writeFileSync(path.join(H, '.deepcode', 'settings.json'), JSON.stringify(s, null, 2))
  return H
}

function runOne(model, home, scenario, seed) {
  const dir = path.join(ROOT, model, scenario.id, 's' + seed)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  scenario.seed(dir, assets)
  const t0 = Date.now()
  const r = spawnSync('node', [DC, '-p', scenario.prompt, '--json', '--yolo'], {
    cwd: dir, env: { ...process.env, HOME: home }, encoding: 'utf8',
    timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
  })
  const secs = (Date.now() - t0) / 1000
  const out = (r.stdout ?? '').trim().split('\n').filter(l => l.trim().startsWith('{')).pop() ?? '{}'
  let meta = {}
  try { meta = JSON.parse(out) } catch {}
  return { dir, secs, status: meta.status ?? (r.error ? 'error' : 'unknown'),
    turns: meta.turns ?? 0, cost: meta.costCNY ?? 0, err: r.error?.message }
}

const results = [] // {model, scenario, seed, pass, detail, secs, turns, cost, status}
console.log(`=== deepcode eval ===  模型=[${MODELS}] 场景=[${scenarios.map(s => s.id)}] seeds=${SEEDS}\n`)
for (const model of MODELS) {
  const home = homeFor(model)
  for (const sc of scenarios) {
    for (let seed = 1; seed <= SEEDS; seed++) {
      process.stdout.write(`  ${model} · ${sc.id} · s${seed} … `)
      const run = runOne(model, home, sc, seed)
      let v = { pass: false, detail: 'run 未完成' }
      if (run.status === 'done') { try { v = await sc.verify(run.dir) } catch (e) { v = { pass: false, detail: 'verify异常:' + e.message } } }
      else v = { pass: false, detail: `status=${run.status}${run.err ? ' ' + run.err : ''}` }
      results.push({ model, scenario: sc.id, seed, ...v, secs: run.secs, turns: run.turns, cost: run.cost, status: run.status })
      console.log(`${v.pass ? '✓' : '✗'} (${run.secs.toFixed(0)}s ¥${run.cost.toFixed(4)}) ${v.pass ? '' : '— ' + v.detail}`)
    }
  }
}

// ---- 汇总 ----
console.log('\n=== 汇总矩阵（pass^N = N 次全过 / passN 通过数）===')
const models = [...new Set(results.map(r => r.model))]
const scens = [...new Set(results.map(r => r.scenario))]
const agg = {}
for (const m of models) for (const s of scens) {
  const rows = results.filter(r => r.model === m && r.scenario === s)
  const passN = rows.filter(r => r.pass).length
  agg[`${m}|${s}`] = {
    passN, N: rows.length, passHatK: passN === rows.length,
    avgCost: rows.reduce((a, r) => a + r.cost, 0) / rows.length,
    avgSecs: rows.reduce((a, r) => a + r.secs, 0) / rows.length,
    avgTurns: rows.reduce((a, r) => a + r.turns, 0) / rows.length,
  }
}
// 打印表
const pad = (s, n) => String(s).padEnd(n)
console.log(pad('场景', 16) + models.map(m => pad(m, 22)).join(''))
for (const s of scens) {
  let line = pad(s, 16)
  for (const m of models) {
    const a = agg[`${m}|${s}`]
    line += pad(`${a.passN}/${a.N}${a.passHatK ? '★' : ''} ¥${a.avgCost.toFixed(3)} ${a.avgSecs.toFixed(0)}s`, 22)
  }
  console.log(line)
}
// 每模型总分
console.log('\n=== 每模型总览 ===')
for (const m of models) {
  const rows = results.filter(r => r.model === m)
  const pass = rows.filter(r => r.pass).length
  const reliable = scens.filter(s => agg[`${m}|${s}`].passHatK).length
  console.log(`  ${pad(m, 20)} 通过率 ${pass}/${rows.length}  可靠场景(pass^N) ${reliable}/${scens.length}  总花费 ¥${rows.reduce((a, r) => a + r.cost, 0).toFixed(3)}`)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify({ config: { MODELS, SEEDS, scenarios: scens }, results, agg }, null, 2))
console.log(`\n结果 JSON: ${OUT}`)
