// deepcode eval harness · 场景集（全部防污染自造 + 程序化判分）
// 每个场景：{ id, prompt, seed(dir), verify(dir) -> {pass:boolean, detail:string} }
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const w = (dir, rel, content) => {
  const p = path.join(dir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
const readSafe = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
// 在 dir 下动态 import 一个模块并取导出（拿不到返回 null）
async function imp(dir, rel, name) {
  try { const m = await import('file://' + path.join(dir, rel) + '?t=' + Date.now()); return m[name] ?? null }
  catch { return null }
}
// 在 dir 下跑 node --test，返回是否全过
function nodeTestPass(dir) {
  const r = spawnSync('node', ['--test'], { cwd: dir, encoding: 'utf8', timeout: 30000 })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const pass = /# pass (\d+)/.exec(out)?.[1]
  const fail = /# fail (\d+)/.exec(out)?.[1]
  return { ok: r.status === 0 && fail === '0' && Number(pass) > 0, pass, fail }
}

export const SCENARIOS = [
  {
    id: 'bugfix',
    prompt: 'src/stats.mjs 里 average([2,4,6]) 期望返回 4，但实际返回了 6。定位并修复这个 bug。',
    seed: (dir) => w(dir, 'src/stats.mjs',
      'export function average(nums) {\n  let total = 0\n  for (const n of nums) total += n\n  return total / (nums.length - 1)\n}\n'),
    verify: async (dir) => {
      const average = await imp(dir, 'src/stats.mjs', 'average')
      if (!average) return { pass: false, detail: '导出 average 丢失/文件损坏' }
      const v = average([2, 4, 6])
      return { pass: Math.abs(v - 4) < 1e-9, detail: `average([2,4,6])=${v}（期望 4）` }
    },
  },
  {
    id: 'refactor',
    prompt: "src/user.mjs 和 src/order.mjs 里有重复的邮箱校验逻辑（!email || !email.includes('@') 就抛错）。抽成公共函数 validateEmail 放到 src/validate.mjs（导出 validateEmail），两个文件都改用它。",
    seed: (dir) => {
      w(dir, 'src/user.mjs', "export function createUser(email, name) {\n  if (!email || !email.includes('@')) throw new Error('invalid email')\n  return { email, name }\n}\n")
      w(dir, 'src/order.mjs', "export function createOrder(email, item) {\n  if (!email || !email.includes('@')) throw new Error('invalid email')\n  return { email, item }\n}\n")
    },
    verify: async (dir) => {
      const validateEmail = await imp(dir, 'src/validate.mjs', 'validateEmail')
      if (!validateEmail) return { pass: false, detail: 'validate.mjs 未导出 validateEmail' }
      const createUser = await imp(dir, 'src/user.mjs', 'createUser')
      const createOrder = await imp(dir, 'src/order.mjs', 'createOrder')
      if (!createUser || !createOrder) return { pass: false, detail: 'user/order 导出损坏' }
      // 残留内联校验？
      const residual = /includes\(['"]@['"]\)/.test(readSafe(path.join(dir, 'src/user.mjs')))
        || /includes\(['"]@['"]\)/.test(readSafe(path.join(dir, 'src/order.mjs')))
      if (residual) return { pass: false, detail: '仍残留内联邮箱校验（未真正抽取）' }
      // 行为仍正确？
      let good = false, bad = false
      try { createUser('a@b.com', 'x'); createOrder('a@b.com', 'y'); good = true } catch {}
      try { createUser('nope', 'x'); bad = false } catch { bad = true }
      return { pass: good && bad, detail: `好邮箱通过=${good} 坏邮箱抛错=${bad} 无残留` }
    },
  },
  {
    id: 'recovery',
    prompt: '跑 `node --test`，如果测试失败就修到全部通过。',
    seed: (dir) => {
      w(dir, 'calc.mjs', 'export function add(a, b) {\n  return a - b\n}\n')
      w(dir, 'calc.test.mjs', "import { add } from './calc.mjs'\nimport assert from 'node:assert'\nimport { test } from 'node:test'\ntest('add(2,3) === 5', () => assert.strictEqual(add(2, 3), 5))\n")
    },
    verify: async (dir) => {
      const r = nodeTestPass(dir)
      return { pass: r.ok, detail: `node --test pass=${r.pass} fail=${r.fail}` }
    },
  },
  {
    id: 'evaluator',
    prompt: "用 JS（Node，.mjs）实现一个算术表达式求值器：支持 + − * / 括号 一元负号，正确处理优先级；非法输入（如 '1++2'、'(2+3'、除以零）抛错。必须导出一个函数 `evaluate(expr: string): number` 放在 `evaluator.mjs`。配 `node --test` 测试并确保全过。",
    seed: () => {},
    verify: async (dir) => {
      const evaluate = await imp(dir, 'evaluator.mjs', 'evaluate')
      if (!evaluate) return { pass: false, detail: 'evaluator.mjs 未导出 evaluate' }
      const cases = [['2+3*4', 14], ['(2+3)*4', 20], ['-2+5', 3], ['2*(3+4)-10/2', 9], ['-(-5)', 5], ['3.5*2', 7], ['10/(5-5)', 'ERR'], ['1++2', 'ERR'], ['(2+3', 'ERR']]
      let okN = 0
      const fails = []
      for (const [e, exp] of cases) {
        let got, threw = false
        try { got = evaluate(e) } catch { threw = true }
        const ok = exp === 'ERR' ? threw : (!threw && Math.abs(got - exp) < 1e-9)
        if (ok) okN++; else fails.push(`${e}→${threw ? 'ERR' : got}(期${exp})`)
      }
      return { pass: okN === cases.length, detail: `刁钻用例 ${okN}/${cases.length}${fails.length ? ' 失:' + fails.join(',') : ''}` }
    },
  },
  {
    id: 'log-analysis',
    // access.log 由 harness 统一生成（含预埋异常），seed 时拷入
    prompt: '分析当前目录下的 access.log（Nginx 访问日志）：统计请求量最高的 IP、整体错误率、找出任何可疑或异常的模式。把发现和结论写到 analysis.md。',
    seed: (dir, assets) => fs.writeFileSync(path.join(dir, 'access.log'), assets.accessLog),
    verify: async (dir) => {
      const md = readSafe(path.join(dir, 'analysis.md'))
      if (!md) return { pass: false, detail: 'analysis.md 未生成' }
      const checks = {
        topIp: /10\.0\.0\.66/.test(md),
        brute: /暴力|brute|破解|failed login|401/i.test(md),
        count80: /\b80\b/.test(md),
        checkout500: /checkout/i.test(md) && /500/.test(md),
        count18: /\b18\b/.test(md),
        errRate: /33\.|93/.test(md),
      }
      const passed = Object.values(checks).filter(Boolean).length
      // 必须抓到两个核心异常（top IP 暴力破解 + checkout 500）才算过
      const pass = checks.topIp && checks.brute && checks.checkout500 && passed >= 5
      return { pass, detail: `命中 ${passed}/6：${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(',') || '全中'}` }
    },
  },
]

// access.log 生成（与 battle 一致，确定性）——供 log-analysis 场景
export function genAccessLog() {
  const lines = []
  const normalIps = ['203.0.113.5', '198.51.100.9', '203.0.113.44', '198.51.100.7', '203.0.113.8']
  const paths = ['/', '/index.html', '/about', '/products', '/api/list', '/static/app.js', '/favicon.ico']
  const stamp = (sec) => `20/May/2025:10:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')} +0000`
  let t = 1000
  for (let i = 0; i < 150; i++) {
    const status = (i % 37 === 0) ? 404 : 200
    lines.push({ t: t++, s: `${normalIps[i % 5]} - - [${stamp(t)}] "GET ${paths[i % 7]} HTTP/1.1" ${status} ${200 + i * 13 % 5000} "-" "Mozilla/5.0"` })
  }
  for (let i = 0; i < 80; i++) {
    const status = (i % 8 === 0) ? 200 : 401
    lines.push({ t: t++, s: `10.0.0.66 - - [${stamp(t)}] "POST /login HTTP/1.1" ${status} 150 "-" "curl/7.68.0"` })
  }
  for (let i = 0; i < 18; i++) lines.push({ t: t++, s: `198.51.100.7 - - [${stamp(t)}] "POST /api/checkout HTTP/1.1" 500 512 "-" "Mozilla/5.0"` })
  for (let i = 0; i < 30; i++) lines.push({ t: t++, s: `${normalIps[i % 5]} - - [${stamp(t)}] "GET ${paths[i % 7]} HTTP/1.1" 200 ${300 + i * 7} "-" "Mozilla/5.0"` })
  lines.sort((a, b) => ((a.t * 2654435761) % 1000) - ((b.t * 2654435761) % 1000))
  return lines.map(l => l.s).join('\n') + '\n'
}
