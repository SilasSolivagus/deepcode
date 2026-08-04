import { describe, it, expect } from 'vitest'
import {
  parseFrozenReport, buildArtifact, runFrozenTests,
  type CommandRunner, type BuildResult,
} from '../bench/ab/frozenHarness.js'

/** 记录被调用的命令，并按脚本返回结果 */
function fakeRunner(script: Array<{ ok: boolean; output: string }>) {
  const calls: Array<{ cmd: string; args: string[]; cwd: string; env?: Record<string, string> }> = []
  const run: CommandRunner = (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd, env: opts.env })
    return script.shift() ?? { ok: false, output: '脚本用尽' }
  }
  return { run, calls }
}

const OK: BuildResult = { installed: true, built: true, notes: '' }

// 字段名实读自 #6 那次评测留下的真实产物 /Users/silas/loop/eval-6/report/r1-result.json
const REPORT = (passed: number, failed: number, total: number) =>
  JSON.stringify({ numTotalTests: total, numPassedTests: passed, numFailedTests: failed, success: failed === 0 })

describe('parseFrozenReport', () => {
  it('抽出通过/失败/总数', () => {
    expect(parseFrozenReport(REPORT(12, 34, 46))).toEqual({ scored: true, passed: 12, failed: 34, total: 46 })
  })
  it('全过', () => {
    expect(parseFrozenReport(REPORT(46, 0, 46))).toEqual({ scored: true, passed: 46, failed: 0, total: 46 })
  })
  it('畸形 JSON → scored 为假，计数归零（不抛出）', () => {
    expect(parseFrozenReport('{不是 JSON')).toEqual({ scored: false, passed: 0, failed: 0, total: 0 })
  })
  it('JSON 合法但缺字段 → scored 为假', () => {
    expect(parseFrozenReport('{"foo":1}')).toEqual({ scored: false, passed: 0, failed: 0, total: 0 })
  })
  it('字段不是数字 → scored 为假', () => {
    expect(parseFrozenReport('{"numTotalTests":"46","numPassedTests":1,"numFailedTests":0}'))
      .toEqual({ scored: false, passed: 0, failed: 0, total: 0 })
  })
  it('总数为 0 → scored 为假（考卷一道都没跑，不该当成「全过」）', () => {
    expect(parseFrozenReport(REPORT(0, 0, 0))).toEqual({ scored: false, passed: 0, failed: 0, total: 0 })
  })
})

describe('buildArtifact', () => {
  it('装依赖与构建都成功', () => {
    const { run, calls } = fakeRunner([{ ok: true, output: 'installed' }, { ok: true, output: 'built' }])
    expect(buildArtifact({ workDir: '/w', run })).toMatchObject({ installed: true, built: true })
    expect(calls).toHaveLength(2)
    expect(calls[0].args).toEqual(['install'])
    expect(calls[1].args).toEqual(['run', 'build'])
    expect(calls[0].cwd).toBe('/w')
  })

  it('装依赖失败 → 短路，不再构建', () => {
    const { run, calls } = fakeRunner([{ ok: false, output: 'ENOTFOUND registry' }])
    const r = buildArtifact({ workDir: '/w', run })
    expect(r.installed).toBe(false)
    expect(r.built).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('构建失败 → installed 为真、built 为假', () => {
    const { run } = fakeRunner([{ ok: true, output: '' }, { ok: false, output: 'tsc error' }])
    expect(buildArtifact({ workDir: '/w', run })).toMatchObject({ installed: true, built: false })
  })

  it('失败时把诊断原文带进 notes（供人事后看）', () => {
    const { run } = fakeRunner([{ ok: false, output: 'ENOTFOUND registry.npmjs.org' }])
    expect(buildArtifact({ workDir: '/w', run }).notes).toContain('ENOTFOUND')
  })
})

describe('runFrozenTests', () => {
  it('构建没成功就不跑考卷', () => {
    const { run, calls } = fakeRunner([])
    const r = runFrozenTests({
      workDir: '/w', harnessDir: '/h', outputFile: '/o.json',
      build: { installed: true, built: false, notes: 'tsc error' }, run,
    })
    expect(calls).toHaveLength(0)
    expect(r).toMatchObject({ installed: true, built: false, scored: false, passed: 0, failed: 0, total: 0 })
  })

  it('构建成功 → 在考卷目录里跑，注入 LOGSTAT_DIR，显式指定 outputFile', () => {
    const { run, calls } = fakeRunner([{ ok: true, output: '' }])
    runFrozenTests({
      workDir: '/w', harnessDir: '/h', outputFile: '/out/r.json', build: OK, run,
      readFile: () => REPORT(46, 0, 46),
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].cwd).toBe('/h')                       // 在考卷目录里跑
    expect(calls[0].env?.LOGSTAT_DIR).toBe('/w')          // 指向被测产物
    expect(calls[0].args).toContain('--outputFile=/out/r.json') // 绝对路径，不走写死的那个
    expect(calls[0].args.join(' ')).not.toContain('npm test')   // 绝不走考卷自带脚本
  })

  it('考卷跑完 → 带回计数', () => {
    const { run } = fakeRunner([{ ok: true, output: '' }])
    const r = runFrozenTests({
      workDir: '/w', harnessDir: '/h', outputFile: '/o.json', build: OK, run,
      readFile: () => REPORT(12, 34, 46),
    })
    expect(r).toMatchObject({ scored: true, passed: 12, failed: 34, total: 46 })
  })

  it('考卷有失败时进程退出码非零，但仍要解析出计数（不能当成没跑）', () => {
    const { run } = fakeRunner([{ ok: false, output: '34 failed' }])
    const r = runFrozenTests({
      workDir: '/w', harnessDir: '/h', outputFile: '/o.json', build: OK, run,
      readFile: () => REPORT(12, 34, 46),
    })
    expect(r).toMatchObject({ scored: true, passed: 12, failed: 34 })
  })

  it('结果文件读不到 → scored 为假，不抛出', () => {
    const { run } = fakeRunner([{ ok: true, output: '' }])
    const r = runFrozenTests({
      workDir: '/w', harnessDir: '/h', outputFile: '/o.json', build: OK, run,
      readFile: () => { throw new Error('ENOENT') },
    })
    expect(r.scored).toBe(false)
  })

  it('把构建阶段的 installed/built 原样带出来', () => {
    const { run } = fakeRunner([{ ok: true, output: '' }])
    const r = runFrozenTests({
      workDir: '/w', harnessDir: '/h', outputFile: '/o.json', build: OK, run,
      readFile: () => REPORT(46, 0, 46),
    })
    expect(r).toMatchObject({ installed: true, built: true })
  })
})
