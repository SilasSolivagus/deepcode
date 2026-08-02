import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PREDICATES, evalObservation, type RunArtifacts } from '../bench/ab/predicates.js'

const base = (over: Partial<RunArtifacts> = {}): RunArtifacts => ({
  bashCommands: [], exitCode: 0, status: 'done', turns: 10, outputDir: '/tmp', ...over,
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
  it('min 缺失时返回 null（通过 evalObservation 降级）', () => {
    const a = base({ bashCommands: ['gen 2048 * 1024 * 1024'] })
    expect(evalObservation(a, 'numericFromBashAtLeast', { pattern: '(\\d+)\\s*\\*\\s*1024\\s*\\*\\s*1024' })).toBeNull()
  })
  it('min 是非数字字符串时返回 null（通过 evalObservation 降级）', () => {
    const a = base({ bashCommands: ['gen 2048 * 1024 * 1024'] })
    expect(evalObservation(a, 'numericFromBashAtLeast', { pattern: '(\\d+)\\s*\\*\\s*1024\\s*\\*\\s*1024', min: 'not-a-number' })).toBeNull()
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
  it('fileExists 含 ../ 的路径逃逸被阻止，返回 null（通过 evalObservation）', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'ab-pred-'))
    expect(evalObservation(base({ outputDir: d }), 'fileExists', { relPath: '../../etc/passwd' })).toBeNull()
  })
  it('fileExists 绝对路径逃逸被阻止，返回 null（通过 evalObservation）', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'ab-pred-'))
    expect(evalObservation(base({ outputDir: d }), 'fileExists', { relPath: '/etc/passwd' })).toBeNull()
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
  it('判定器名不存在 → null（不抛出）', () => {
    expect(evalObservation(base(), 'noSuchPredicate', {})).toBeNull()
  })
  it('判定器抛异常 → null（一个坏判定器不该毁掉整轮）', () => {
    // 非法正则会让 RegExp 构造抛出
    expect(evalObservation(base(), 'bashCommandsAnyMatch', { pattern: '(' })).toBeNull()
  })
})
