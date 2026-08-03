import { describe, it, expect } from 'vitest'
import { buildReport, type RunRecord } from '../bench/ab/report.js'
import type { Declaration } from '../bench/ab/declaration.js'
import type { RunArtifacts } from '../bench/ab/predicates.js'

const artifacts = (over: Partial<RunArtifacts> = {}): RunArtifacts => ({
  bashCommands: [], bashResults: [], editedFiles: [], agentSpawns: [], subagentRuns: [],
  exitCode: 0, status: 'done', turns: 10, outputDir: '/tmp', ...over,
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
