import { describe, it, expect } from 'vitest'
import { buildReport, type RunRecord } from '../bench/ab/report.js'
import type { Declaration } from '../bench/ab/declaration.js'
import type { RunArtifacts } from '../bench/ab/predicates.js'
import type { FrozenResult } from '../bench/ab/frozenHarness.js'

const artifacts = (over: Partial<RunArtifacts> = {}): RunArtifacts => ({
  bashCommands: [], bashResults: [], editedFiles: [], agentSpawns: [], subagentRuns: [],
  exitCode: 0, finalText: '', status: 'done', turns: 10, frozen: null, outputDir: '/tmp', ...over,
})

const decl = (observations: Declaration['observations']): Declaration => ({
  id: 'test-decl',
  desc: 'desc',
  arms: { treatment: { verificationAgent: true }, baseline: {} },
  treatmentArm: 'treatment',
  k: 5,
  task: { taskbook: 'tb', frozen: 'fr', harness: 'ha' },
  observations,
})

const rec = (arm: string, seed: number, observations: RunRecord['observations']): RunRecord => ({
  arm, seed, runDir: `/tmp/${arm}-${seed}`, artifacts: artifacts(), observations,
})

describe('I6：对照臂分母恒为 0 时 p 值格印成破折号而非数字', () => {
  it('对照臂全部 na → p 格是「—（对照臂无有效样本）」而不是 1.0000', () => {
    const d = decl([{ id: 'loop-closed', desc: 'x', predicate: 'editAfterVerdict', args: {}, expect: true }])
    const records: RunRecord[] = [
      rec('treatment', 1, { 'loop-closed': true }),
      rec('baseline', 1, { 'loop-closed': 'na' }), // 对照臂没有该机制，恒 na
    ]
    const md = buildReport({ decl: d, records, hashBefore: 'h', hashAfter: 'h', outRoot: '/out' })
    expect(md).toContain('—（对照臂无有效样本）')
    expect(md).not.toMatch(/\|\s*1\.0000\s*\|/)
  })

  it('两臂都有有效样本 → 正常印数字 p 值', () => {
    const d = decl([{ id: 'x', desc: 'y', predicate: 'statusIs', args: {}, expect: true }])
    const records: RunRecord[] = [
      rec('treatment', 1, { x: true }),
      rec('baseline', 1, { x: false }),
    ]
    const md = buildReport({ decl: d, records, hashBefore: 'h', hashAfter: 'h', outRoot: '/out' })
    expect(md).toMatch(/\|\s*\d\.\d{4}\s*\|/)
  })
})

describe('I7：na 与 error 在报告里分两行印，都不计入分母', () => {
  it('na 记录出现在「本次跑不适用」一节，error 记录出现在「判定器不存在或抛异常」一节', () => {
    const d = decl([
      { id: 'obs-na', desc: 'x', predicate: 'editAfterVerdict', args: {}, expect: true },
      { id: 'obs-err', desc: 'y', predicate: 'statusIs', args: {}, expect: true },
    ])
    const records: RunRecord[] = [
      rec('treatment', 1, { 'obs-na': 'na', 'obs-err': 'error' }),
      rec('baseline', 1, { 'obs-na': true, 'obs-err': true }),
    ]
    const md = buildReport({ decl: d, records, hashBefore: 'h', hashAfter: 'h', outRoot: '/out' })
    expect(md).toContain('本次跑不适用')
    expect(md).toContain('obs-na')
    expect(md).toContain('判定器不存在或抛异常')
    expect(md).toContain('obs-err')
  })

  it('valid 分母排除 na 与 error，只数真正求出布尔值的记录', () => {
    const d = decl([{ id: 'obs', desc: 'x', predicate: 'statusIs', args: {}, expect: true }])
    const records: RunRecord[] = [
      rec('treatment', 1, { obs: true }),
      rec('treatment', 2, { obs: 'na' }),
      rec('treatment', 3, { obs: 'error' }),
      rec('baseline', 1, { obs: false }),
    ]
    const md = buildReport({ decl: d, records, hashBefore: 'h', hashAfter: 'h', outRoot: '/out' })
    // treatment：1 条命中、有效分母只数真正求出布尔值的那一条（1/1），na/error 各 1 次被排除
    expect(md).toContain('**1/1**')
  })
})

describe('I7：「每次跑」表的考卷列', () => {
  const d = decl([{ id: 'x', desc: 'y', predicate: 'statusIs', args: {}, expect: true }])

  it('四种取值：未跑考卷 / 构建失败 / 跑了没判出分 / 判出分数', () => {
    const notRun: RunRecord = { arm: 'baseline', seed: 1, runDir: '/tmp/a', artifacts: artifacts({ frozen: null }), observations: { x: true } }
    const buildFailed: RunRecord = {
      arm: 'baseline', seed: 2, runDir: '/tmp/b',
      artifacts: artifacts({ frozen: { installed: true, built: false, notes: 'tsc error', scored: false, passed: 0, failed: 0, total: 0 } as FrozenResult }),
      observations: { x: true },
    }
    const unscored: RunRecord = {
      arm: 'treatment', seed: 1, runDir: '/tmp/c',
      artifacts: artifacts({ frozen: { installed: true, built: true, notes: '考卷结果解析不出计数：\n...', scored: false, passed: 0, failed: 0, total: 0 } as FrozenResult }),
      observations: { x: true },
    }
    const scored: RunRecord = {
      arm: 'treatment', seed: 2, runDir: '/tmp/d',
      artifacts: artifacts({ frozen: { installed: true, built: true, notes: '', scored: true, passed: 42, failed: 4, total: 46 } as FrozenResult }),
      observations: { x: true },
    }
    const md = buildReport({ decl: d, records: [notRun, buildFailed, unscored, scored], hashBefore: 'h', hashAfter: 'h', outRoot: '/out' })
    expect(md).toMatch(/\|\s*baseline\s*\|\s*1\s*\|.*\|\s*—\s*\|\s*`\/tmp\/a`\s*\|/)
    expect(md).toMatch(/\|\s*baseline\s*\|\s*2\s*\|.*\|\s*构建失败\s*\|\s*`\/tmp\/b`\s*\|/)
    expect(md).toMatch(/\|\s*treatment\s*\|\s*1\s*\|.*\|\s*未判分\s*\|\s*`\/tmp\/c`\s*\|/)
    expect(md).toMatch(/\|\s*treatment\s*\|\s*2\s*\|.*\|\s*42\/46\s*\|\s*`\/tmp\/d`\s*\|/)
  })
})
