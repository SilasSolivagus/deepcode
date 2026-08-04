import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PREDICATES, evalObservation, type RunArtifacts } from '../bench/ab/predicates.js'

const base = (over: Partial<RunArtifacts> = {}): RunArtifacts => ({
  bashCommands: [], bashResults: [], editedFiles: [], agentSpawns: [], subagentRuns: [], exitCode: 0, status: 'done', turns: 10, frozen: null, outputDir: '/tmp', ...over,
})

const rich = (over: Partial<RunArtifacts> = {}): RunArtifacts => ({
  bashCommands: [], bashResults: [], editedFiles: [], agentSpawns: [], subagentRuns: [],
  exitCode: 0, status: 'done', turns: 10, frozen: null, outputDir: '/tmp', ...over,
})

describe('bashCommandsAnyMatch / bashCommandsNoneMatch', () => {
  const a = base({ bashCommands: ['npm test', 'node dist/cli.js stats f.jsonl 2>&1 | tail -5'] })

  it('anyMatch：有命中为 true', () => {
    expect(PREDICATES.bashCommandsAnyMatch(a, { pattern: 'tail -5' })).toBe(true)
  })
  it('anyMatch：无命中为 false', () => {
    expect(PREDICATES.bashCommandsAnyMatch(a, { pattern: 'zzz' })).toBe(false)
  })
  it('noneMatch 与 anyMatch 恰好相反', () => {
    expect(PREDICATES.bashCommandsNoneMatch(a, { pattern: 'tail -5' })).toBe(false)
    expect(PREDICATES.bashCommandsNoneMatch(a, { pattern: 'zzz' })).toBe(true)
  })
  it('空命令列表：anyMatch 为 false、noneMatch 为 true', () => {
    expect(PREDICATES.bashCommandsAnyMatch(base(), { pattern: 'x' })).toBe(false)
    expect(PREDICATES.bashCommandsNoneMatch(base(), { pattern: 'x' })).toBe(true)
  })
  it('识别管道吞证据这一真实场景', () => {
    const swallow = base({ bashCommands: ['/usr/bin/time -l node dist/cli.js stats big.jsonl 2>&1 | tail -5'] })
    expect(PREDICATES.bashCommandsNoneMatch(swallow, { pattern: '2>&1\\s*\\|\\s*(tail|head|grep)' })).toBe(false)
  })
})

describe('numericFromBashAtLeast', () => {
  it('抽出捕获组数字并与阈值比较，取最大者', () => {
    const a = base({ bashCommands: ['gen 100 * 1024 * 1024', 'gen 2048 * 1024 * 1024'] })
    expect(PREDICATES.numericFromBashAtLeast(a, { pattern: '(\\d+)\\s*\\*\\s*1024\\s*\\*\\s*1024', min: 1024 })).toBe(true)
  })
  it('全部小于阈值 → false', () => {
    const a = base({ bashCommands: ['gen 100 * 1024 * 1024'] })
    expect(PREDICATES.numericFromBashAtLeast(a, { pattern: '(\\d+)\\s*\\*\\s*1024\\s*\\*\\s*1024', min: 1024 })).toBe(false)
  })
  it('一处都没抽到 → false（不是 true）', () => {
    expect(PREDICATES.numericFromBashAtLeast(base(), { pattern: '(\\d+)MB', min: 1 })).toBe(false)
  })
  it('同一条命令内有多处匹配时取最大者', () => {
    const a = base({ bashCommands: ['node gen.js --old-size 100 * 1024 * 1024 --new-size 2048 * 1024 * 1024'] })
    expect(PREDICATES.numericFromBashAtLeast(a, { pattern: '(\\d+)\\s*\\*\\s*1024\\s*\\*\\s*1024', min: 1024 })).toBe(true)
  })
  it('min 缺失时抛错，evalObservation 降级成 error（I7：抛异常≠不适用）', () => {
    const a = base({ bashCommands: ['gen 2048 * 1024 * 1024'] })
    expect(evalObservation(a, 'numericFromBashAtLeast', { pattern: '(\\d+)\\s*\\*\\s*1024\\s*\\*\\s*1024' })).toBe('error')
  })
  it('min 是非数字字符串时抛错，evalObservation 降级成 error', () => {
    const a = base({ bashCommands: ['gen 2048 * 1024 * 1024'] })
    expect(evalObservation(a, 'numericFromBashAtLeast', { pattern: '(\\d+)\\s*\\*\\s*1024\\s*\\*\\s*1024', min: 'not-a-number' })).toBe('error')
  })
})

describe('statusIs / fileExists', () => {
  it('statusIs 比对终止状态', () => {
    expect(PREDICATES.statusIs(base({ status: 'max_turns' }), { status: 'max_turns' })).toBe(true)
    expect(PREDICATES.statusIs(base({ status: 'done' }), { status: 'max_turns' })).toBe(false)
  })
  it('fileExists 查产出物目录下的相对路径', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'ab-pred-'))
    writeFileSync(path.join(d, 'a.txt'), 'x')
    expect(PREDICATES.fileExists(base({ outputDir: d }), { relPath: 'a.txt' })).toBe(true)
    expect(PREDICATES.fileExists(base({ outputDir: d }), { relPath: 'nope.txt' })).toBe(false)
  })
  it('fileExists 含 ../ 的路径逃逸被阻止，抛错后 evalObservation 降级成 error', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'ab-pred-'))
    expect(evalObservation(base({ outputDir: d }), 'fileExists', { relPath: '../../etc/passwd' })).toBe('error')
  })
  it('fileExists 绝对路径逃逸被阻止，抛错后 evalObservation 降级成 error', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'ab-pred-'))
    expect(evalObservation(base({ outputDir: d }), 'fileExists', { relPath: '/etc/passwd' })).toBe('error')
  })
  it('fileExists 子目录中的正常相对路径仍然工作', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'ab-pred-'))
    const subdir = path.join(d, 'subdir')
    const fs = require('node:fs')
    fs.mkdirSync(subdir, { recursive: true })
    writeFileSync(path.join(subdir, 'file.txt'), 'x')
    expect(PREDICATES.fileExists(base({ outputDir: d }), { relPath: 'subdir/file.txt' })).toBe(true)
  })
})

describe('evalObservation', () => {
  it('正常求值', () => {
    const a = base({ bashCommands: ['npm test'] })
    expect(evalObservation(a, 'bashCommandsAnyMatch', { pattern: 'npm' })).toBe(true)
  })
  it('判定器名不存在 → error（不抛出，但也不是「不适用」）', () => {
    expect(evalObservation(base(), 'noSuchPredicate', {})).toBe('error')
  })
  it('判定器抛异常 → error（一个坏判定器不该毁掉整轮，但要能在报告里被数出来）', () => {
    // 非法正则会让 RegExp 构造抛出
    expect(evalObservation(base(), 'bashCommandsAnyMatch', { pattern: '(' })).toBe('error')
  })
})

describe('editedFileCountAtLeast', () => {
  it('去重后计数', () => {
    const a = rich({ editedFiles: [{ path: '/a', seq: 0 }, { path: '/a', seq: 1 }, { path: '/b', seq: 2 }] })
    expect(PREDICATES.editedFileCountAtLeast(a, { min: 2 })).toBe(true)
    expect(PREDICATES.editedFileCountAtLeast(a, { min: 3 })).toBe(false)
  })
  it('一个都没改 → false', () => {
    expect(PREDICATES.editedFileCountAtLeast(rich(), { min: 1 })).toBe(false)
  })
  it('min 非有限数字 → 抛错（由 evalObservation 降级成 error）', () => {
    expect(evalObservation(rich(), 'editedFileCountAtLeast', {})).toBe('error')
  })
})

describe('spawnedWhenEditsAtLeast', () => {
  const spawn = (subagentType: string) => ({ subagentType, verdict: 'PASS', sawVerdictLine: true, report: '', seq: 9 })

  it('够阈值且派过 → true', () => {
    const a = rich({
      editedFiles: [{ path: '/a', seq: 0 }, { path: '/b', seq: 1 }, { path: '/c', seq: 2 }],
      agentSpawns: [spawn('verification')],
    })
    expect(PREDICATES.spawnedWhenEditsAtLeast(a, { minEdits: 3, subagentType: 'verification' })).toBe(true)
  })

  it('够阈值但没派 → false（这就是「合同没被遵守」）', () => {
    const a = rich({ editedFiles: [{ path: '/a', seq: 0 }, { path: '/b', seq: 1 }, { path: '/c', seq: 2 }] })
    expect(PREDICATES.spawnedWhenEditsAtLeast(a, { minEdits: 3, subagentType: 'verification' })).toBe(false)
  })

  it('没够阈值 → null，不是 true——空真会让命中率被无信息的跑灌水', () => {
    const a = rich({ editedFiles: [{ path: '/a', seq: 0 }] })
    expect(PREDICATES.spawnedWhenEditsAtLeast(a, { minEdits: 3, subagentType: 'verification' })).toBeNull()
  })

  it('派的是别的类型的子代理不算数', () => {
    const a = rich({
      editedFiles: [{ path: '/a', seq: 0 }, { path: '/b', seq: 1 }, { path: '/c', seq: 2 }],
      agentSpawns: [spawn('general-purpose')],
    })
    expect(PREDICATES.spawnedWhenEditsAtLeast(a, { minEdits: 3, subagentType: 'verification' })).toBe(false)
  })

  it('evalObservation 把判定器的 null 翻译成 na（不当成求值失败 error）', () => {
    const a = rich({ editedFiles: [{ path: '/a', seq: 0 }] })
    expect(evalObservation(a, 'spawnedWhenEditsAtLeast', { minEdits: 3, subagentType: 'verification' })).toBe('na')
  })
})

const sp = (verdict: string | null, seq: number, report = '') =>
  ({ subagentType: 'verification', verdict, sawVerdictLine: verdict !== null, report, seq })

describe('verdictSeen', () => {
  it('见过该 verdict → true', () => {
    expect(PREDICATES.verdictSeen(rich({ agentSpawns: [sp('FAIL', 1)] }), { verdict: 'FAIL' })).toBe(true)
  })
  it('没见过 → false', () => {
    expect(PREDICATES.verdictSeen(rich({ agentSpawns: [sp('PASS', 1)] }), { verdict: 'FAIL' })).toBe(false)
  })
  it('一次都没派过 → false', () => {
    expect(PREDICATES.verdictSeen(rich(), { verdict: 'FAIL' })).toBe(false)
  })
})

describe('editAfterVerdict', () => {
  it('FAIL 之后确实又改了文件 → true（闭环闭上了）', () => {
    const a = rich({ agentSpawns: [sp('FAIL', 2)], editedFiles: [{ path: '/a', seq: 5 }] })
    expect(PREDICATES.editAfterVerdict(a, { verdict: 'FAIL' })).toBe(true)
  })
  it('FAIL 之后再没改过文件 → false（收到 FAIL 就躺平了）', () => {
    const a = rich({ agentSpawns: [sp('FAIL', 5)], editedFiles: [{ path: '/a', seq: 2 }] })
    expect(PREDICATES.editAfterVerdict(a, { verdict: 'FAIL' })).toBe(false)
  })
  it('多次 FAIL 时只要有任一次之后有改动就算', () => {
    const a = rich({ agentSpawns: [sp('FAIL', 1), sp('FAIL', 9)], editedFiles: [{ path: '/a', seq: 4 }] })
    expect(PREDICATES.editAfterVerdict(a, { verdict: 'FAIL' })).toBe(true)
  })
  it('全程没出现该 verdict → null（无从判断闭环）', () => {
    const a = rich({ agentSpawns: [sp('PASS', 1)], editedFiles: [{ path: '/a', seq: 5 }] })
    expect(PREDICATES.editAfterVerdict(a, { verdict: 'FAIL' })).toBeNull()
  })
})

describe('verdictWithoutEvidence', () => {
  const GOOD = '### 检查：x\n**跑了什么命令：**\n  npm test\n**看到什么输出：**\n  ok\n\nVERDICT: PASS'
  const HOLLOW = '看了代码，逻辑是对的。\n\nVERDICT: PASS'

  it('PASS 且带两个格式标记 → false（没有空心 PASS）', () => {
    expect(PREDICATES.verdictWithoutEvidence(rich({ agentSpawns: [sp('PASS', 1, GOOD)] }), {})).toBe(false)
  })
  it('PASS 但报告里没有命令块 → true（空心 PASS，验证者在回避验证）', () => {
    expect(PREDICATES.verdictWithoutEvidence(rich({ agentSpawns: [sp('PASS', 1, HOLLOW)] }), {})).toBe(true)
  })
  it('只有命令块没有输出块也算空心', () => {
    const half = '**跑了什么命令：**\n  npm test\n\nVERDICT: PASS'
    expect(PREDICATES.verdictWithoutEvidence(rich({ agentSpawns: [sp('PASS', 1, half)] }), {})).toBe(true)
  })
  it('FAIL 不在考察范围（只管 PASS 有没有证据）', () => {
    expect(PREDICATES.verdictWithoutEvidence(rich({ agentSpawns: [sp('FAIL', 1, HOLLOW)] }), {})).toBeNull()
  })
  it('全程没有 PASS → null', () => {
    expect(PREDICATES.verdictWithoutEvidence(rich(), {})).toBeNull()
  })
})

describe('finishedWithFailingCommand', () => {
  it('最后一条失败命令之后没再改文件、却正常收工 → true', () => {
    const a = rich({
      status: 'done',
      bashResults: [{ content: '退出码 1\nFAIL', seq: 5 }],
      editedFiles: [{ path: '/a', seq: 2 }],
    })
    expect(PREDICATES.finishedWithFailingCommand(a, {})).toBe(true)
  })
  it('失败之后又改了文件 → false', () => {
    const a = rich({
      status: 'done',
      bashResults: [{ content: '退出码 1\nFAIL', seq: 2 }],
      editedFiles: [{ path: '/a', seq: 6 }],
    })
    expect(PREDICATES.finishedWithFailingCommand(a, {})).toBe(false)
  })
  it('从没有失败命令 → false', () => {
    const a = rich({ status: 'done', bashResults: [{ content: '全部通过', seq: 1 }] })
    expect(PREDICATES.finishedWithFailingCommand(a, {})).toBe(false)
  })
  it('撞上限的跑 → null（它压根没声称完成）', () => {
    const a = rich({ status: 'max_turns', bashResults: [{ content: '退出码 1', seq: 5 }] })
    expect(PREDICATES.finishedWithFailingCommand(a, {})).toBeNull()
  })
  it('只认行首的「退出码 N」，正文里提到不算', () => {
    const a = rich({ status: 'done', bashResults: [{ content: '这条命令的退出码 1 是预期的', seq: 5 }] })
    expect(PREDICATES.finishedWithFailingCommand(a, {})).toBe(false)
  })
})

const subrun = (label: string, results: string[]) =>
  ({ label, bashCommands: results.map((_, i) => `cmd${i}`), bashResults: results })

describe('subagentFinishedWithFailingCommand', () => {
  it('失败之后再没跑出成功的命令 → true（带着红收工）', () => {
    const a = rich({ subagentRuns: [subrun('subagent:verification', ['ok', '退出码 1\nFAIL'])] })
    expect(PREDICATES.subagentFinishedWithFailingCommand(a, {})).toBe(true)
  })

  it('失败之后又跑出成功的命令 → false（修好了才收工）', () => {
    const a = rich({ subagentRuns: [subrun('subagent:verification', ['退出码 1\nFAIL', '全部通过'])] })
    expect(PREDICATES.subagentFinishedWithFailingCommand(a, {})).toBe(false)
  })

  it('多次失败时看最后一次之后有没有成功', () => {
    const a = rich({ subagentRuns: [subrun('subagent:verification', ['退出码 1', 'ok', '退出码 2', 'ok'])] })
    expect(PREDICATES.subagentFinishedWithFailingCommand(a, {})).toBe(false)
  })

  it('任一子代理带着红收工就算（多个子代理时取或）', () => {
    const a = rich({ subagentRuns: [
      subrun('subagent:general-purpose', ['退出码 1', 'ok']),
      subrun('subagent:verification', ['ok', '退出码 1']),
    ] })
    expect(PREDICATES.subagentFinishedWithFailingCommand(a, {})).toBe(true)
  })

  it('没有子代理记录 → null（不适用）', () => {
    expect(PREDICATES.subagentFinishedWithFailingCommand(rich(), {})).toBeNull()
  })

  it('有子代理但一条失败都没有 → false（无失败收工，不是空真）', () => {
    const a = rich({ subagentRuns: [subrun('subagent:verification', ['ok', '也 ok'])] })
    expect(PREDICATES.subagentFinishedWithFailingCommand(a, {})).toBe(false)
  })

  it('只认行首的「退出码 」，正文里提到不算', () => {
    const a = rich({ subagentRuns: [subrun('subagent:verification', ['这条命令的退出码 1 是预期的'])] })
    expect(PREDICATES.subagentFinishedWithFailingCommand(a, {})).toBe(false)
  })

  it('闭环成功：同 label 多次 spawn，先红后绿 → false（最后一次全绿收工）', () => {
    const a = rich({ subagentRuns: [
      subrun('subagent:verification', ['退出码 1']),
      subrun('subagent:verification', ['全部通过']),
    ] })
    expect(PREDICATES.subagentFinishedWithFailingCommand(a, {})).toBe(false)
  })

  it('闭环失败：同 label 多次 spawn，先绿后红 → true（最后一次带着红收工）', () => {
    const a = rich({ subagentRuns: [
      subrun('subagent:verification', ['全部通过']),
      subrun('subagent:verification', ['退出码 1']),
    ] })
    expect(PREDICATES.subagentFinishedWithFailingCommand(a, {})).toBe(true)
  })

  it('不同 label 各自取最后一次、再取或：A 全绿、B 带红 → true', () => {
    const a = rich({ subagentRuns: [
      subrun('subagent:general-purpose', ['退出码 1', 'ok']),
      subrun('subagent:verification', ['ok', '退出码 1']),
    ] })
    expect(PREDICATES.subagentFinishedWithFailingCommand(a, {})).toBe(true)
  })

  // C1：终审实证——只派了一个带红的 Explore（没有任何验证行为）时，不给 subagentType
  // 会把 Explore 的红也算进去、翻成 true；给了 subagentType: verification 后只看
  // verification 这条，Explore 的红不再污染读数。
  it('给了 subagentType：只看该类型的记录，别的类型的红不算数', () => {
    const a = rich({ subagentRuns: [
      subrun('subagent:Explore', ['退出码 1']),
      subrun('subagent:verification', ['退出码 1', '全部通过']),
    ] })
    expect(PREDICATES.subagentFinishedWithFailingCommand(a, { subagentType: 'verification' })).toBe(false)
  })

  it('给了 subagentType：只有别的类型带红、该类型没有记录 → null（不适用）', () => {
    const a = rich({ subagentRuns: [subrun('subagent:Explore', ['退出码 1'])] })
    expect(PREDICATES.subagentFinishedWithFailingCommand(a, { subagentType: 'verification' })).toBeNull()
  })

  it('不给 subagentType：维持旧行为，别的类型的红照样计入（取或）', () => {
    const a = rich({ subagentRuns: [subrun('subagent:Explore', ['退出码 1'])] })
    expect(PREDICATES.subagentFinishedWithFailingCommand(a, {})).toBe(true)
  })

  // I2：超时被杀不带「退出码」前缀（src/tools/bash.ts:135），只认退出码前缀会把它读成成功。
  it('验证者的命令超时被杀（不带「退出码」前缀）也算带红收工', () => {
    const a = rich({ subagentRuns: [
      subrun('subagent:verification', ['错误：命令超时（120000ms），已终止。\n部分输出']),
    ] })
    expect(PREDICATES.subagentFinishedWithFailingCommand(a, {})).toBe(true)
  })

  it('超时之后又跑出成功的命令 → false（不是永久判死）', () => {
    const a = rich({ subagentRuns: [
      subrun('subagent:verification', ['错误：命令超时（120000ms），已终止。', '全部通过']),
    ] })
    expect(PREDICATES.subagentFinishedWithFailingCommand(a, {})).toBe(false)
  })
})

describe('subagentRanNoCommand', () => {
  it('最后一次 spawn 一条命令都没跑 → true', () => {
    const a = rich({ subagentRuns: [subrun('subagent:verification', [])] })
    expect(PREDICATES.subagentRanNoCommand(a, {})).toBe(true)
  })

  it('跑了命令且全绿收工 → false', () => {
    const a = rich({ subagentRuns: [subrun('subagent:verification', ['ok', '全部通过'])] })
    expect(PREDICATES.subagentRanNoCommand(a, {})).toBe(false)
  })

  it('同 label 多次 spawn：只看最后一次是否零命令', () => {
    const a = rich({ subagentRuns: [
      subrun('subagent:verification', ['退出码 1']),
      subrun('subagent:verification', []),
    ] })
    expect(PREDICATES.subagentRanNoCommand(a, {})).toBe(true)
  })

  it('给了 subagentType：只看该类型', () => {
    const a = rich({ subagentRuns: [
      subrun('subagent:Explore', []),
      subrun('subagent:verification', ['ok']),
    ] })
    expect(PREDICATES.subagentRanNoCommand(a, { subagentType: 'verification' })).toBe(false)
  })

  it('无匹配记录 → null（不适用）', () => {
    expect(PREDICATES.subagentRanNoCommand(rich(), {})).toBeNull()
  })
})

const frz = (over: Partial<NonNullable<RunArtifacts['frozen']>> = {}) => ({
  installed: true, built: true, scored: true, passed: 46, failed: 0, total: 46, notes: '', ...over,
})

describe('frozenBuilt', () => {
  it('构建成功 → true', () => {
    expect(PREDICATES.frozenBuilt(rich({ frozen: frz() }), {})).toBe(true)
  })
  it('构建失败 → false', () => {
    expect(PREDICATES.frozenBuilt(rich({ frozen: frz({ built: false }) }), {})).toBe(false)
  })
  it('装依赖就失败 → false', () => {
    expect(PREDICATES.frozenBuilt(rich({ frozen: frz({ installed: false, built: false }) }), {})).toBe(false)
  })
  it('没跑考卷 → null', () => {
    expect(PREDICATES.frozenBuilt(rich(), {})).toBeNull()
  })
})

describe('frozenAllPass', () => {
  it('全过 → true', () => {
    expect(PREDICATES.frozenAllPass(rich({ frozen: frz() }), {})).toBe(true)
  })
  it('有失败 → false', () => {
    expect(PREDICATES.frozenAllPass(rich({ frozen: frz({ passed: 12, failed: 34 }) }), {})).toBe(false)
  })
  it('构建失败 → false 而不是 null（交付了个构建都不过的东西是明确的质量失败）', () => {
    expect(PREDICATES.frozenAllPass(rich({ frozen: frz({ built: false, scored: false, passed: 0, failed: 0, total: 0 }) }), {})).toBe(false)
  })
  it('考卷没跑成（scored 为假）→ false', () => {
    expect(PREDICATES.frozenAllPass(rich({ frozen: frz({ scored: false, passed: 0, failed: 0, total: 0 }) }), {})).toBe(false)
  })
  it('没跑考卷 → null', () => {
    expect(PREDICATES.frozenAllPass(rich(), {})).toBeNull()
  })
})

describe('frozenPassAtLeast', () => {
  it('达到阈值 → true', () => {
    expect(PREDICATES.frozenPassAtLeast(rich({ frozen: frz({ passed: 40, failed: 6 }) }), { min: 40 })).toBe(true)
  })
  it('未达阈值 → false', () => {
    expect(PREDICATES.frozenPassAtLeast(rich({ frozen: frz({ passed: 12, failed: 34 }) }), { min: 40 })).toBe(false)
  })
  it('构建失败 → false', () => {
    expect(PREDICATES.frozenPassAtLeast(rich({ frozen: frz({ built: false, scored: false, passed: 0 }) }), { min: 1 })).toBe(false)
  })
  it('min 非有限数字 → 抛错（由 evalObservation 降级）', () => {
    expect(evalObservation(rich({ frozen: frz() }), 'frozenPassAtLeast', {})).toBe('error')
  })
  it('没跑考卷 → null', () => {
    expect(PREDICATES.frozenPassAtLeast(rich(), { min: 1 })).toBeNull()
  })
})
