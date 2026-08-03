import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { recoverSubagentRuns } from '../bench/ab/subagentTrace.js'

/** 造一个轨迹目录，rec 是 { seq, label, messages } 的简写 */
function mkTrace(recs: Array<{ seq: number; label: string; messages: any[] }>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-subtrace-'))
  for (const r of recs) {
    writeFileSync(
      path.join(dir, `req-${String(r.seq).padStart(5, '0')}.json`),
      JSON.stringify({ seq: r.seq, ts: '', label: r.label, model: 'm', messages: r.messages, tools: [], params: {} }),
    )
  }
  return dir
}

/** 一次 Bash 调用在 wire messages 里的形状（实读自 src/loop.ts:270 与 :379） */
const bashCall = (id: string, command: string) => ({
  role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command }) } }],
})
const bashResult = (id: string, content: string) => ({ role: 'tool', tool_call_id: id, content })

describe('recoverSubagentRuns', () => {
  it('按 tool_call_id 配对出命令与结果', () => {
    const dir = mkTrace([{
      seq: 1, label: 'subagent:verification',
      messages: [
        { role: 'system', content: 's' },
        bashCall('t1', 'npm test'),
        bashResult('t1', '退出码 1\nFAIL'),
      ],
    }])
    const runs = recoverSubagentRuns(dir, 'subagent:')
    expect(runs).toHaveLength(1)
    expect(runs[0].label).toBe('subagent:verification')
    expect(runs[0].bashCommands).toEqual(['npm test'])
    expect(runs[0].bashResults).toEqual(['退出码 1\nFAIL'])
  })

  it('乱序的 tool_call_id 也配得对（并发调用时相邻关系不可靠）', () => {
    const dir = mkTrace([{
      seq: 1, label: 'subagent:verification',
      messages: [
        { role: 'assistant', content: null, tool_calls: [
          { id: 'a', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: '甲' }) } },
          { id: 'b', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: '乙' }) } },
        ] },
        bashResult('b', '乙的结果'),
        bashResult('a', '甲的结果'),
      ],
    }])
    const runs = recoverSubagentRuns(dir, 'subagent:')
    expect(runs[0].bashCommands).toEqual(['甲', '乙'])
    expect(runs[0].bashResults).toEqual(['甲的结果', '乙的结果'])
  })

  it('同一 label 只取 seq 最大的那条（请求是累积的）', () => {
    const dir = mkTrace([
      { seq: 1, label: 'subagent:verification', messages: [bashCall('t1', '第一次'), bashResult('t1', 'r1')] },
      { seq: 9, label: 'subagent:verification', messages: [
        bashCall('t1', '第一次'), bashResult('t1', 'r1'),
        bashCall('t2', '第二次'), bashResult('t2', 'r2'),
      ] },
    ])
    const runs = recoverSubagentRuns(dir, 'subagent:')
    expect(runs).toHaveLength(1)
    expect(runs[0].bashCommands).toEqual(['第一次', '第二次'])
  })

  it('不同 label 各自一条记录', () => {
    const dir = mkTrace([
      { seq: 1, label: 'subagent:verification', messages: [bashCall('t1', '甲'), bashResult('t1', 'r甲')] },
      { seq: 2, label: 'subagent:general-purpose', messages: [bashCall('t2', '乙'), bashResult('t2', 'r乙')] },
    ])
    const runs = recoverSubagentRuns(dir, 'subagent:').sort((x, y) => x.label.localeCompare(y.label))
    expect(runs.map(r => r.label)).toEqual(['subagent:general-purpose', 'subagent:verification'])
  })

  it('主循环的记录（label 为 turn）不被算进来', () => {
    const dir = mkTrace([{ seq: 1, label: 'turn', messages: [bashCall('t1', '主代理跑的'), bashResult('t1', 'r')] }])
    expect(recoverSubagentRuns(dir, 'subagent:')).toEqual([])
  })

  it('非 Bash 的工具调用不算命令', () => {
    const dir = mkTrace([{
      seq: 1, label: 'subagent:verification',
      messages: [
        { role: 'assistant', content: null, tool_calls: [
          { id: 'r1', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: '/a' }) } },
        ] },
        bashResult('r1', '文件内容'),
      ],
    }])
    expect(recoverSubagentRuns(dir, 'subagent:')[0].bashCommands).toEqual([])
  })

  it('有命令但没有对应结果时不产出该条（轨迹被截断）', () => {
    const dir = mkTrace([{ seq: 1, label: 'subagent:verification', messages: [bashCall('t1', '没结果的')] }])
    expect(recoverSubagentRuns(dir, 'subagent:')[0].bashCommands).toEqual([])
  })

  it('arguments 不是合法 JSON 时跳过该条命令，不整体失败', () => {
    const dir = mkTrace([{
      seq: 1, label: 'subagent:verification',
      messages: [
        { role: 'assistant', content: null, tool_calls: [
          { id: 'bad', type: 'function', function: { name: 'Bash', arguments: '{不是 JSON' } },
          { id: 'ok', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: '好的' }) } },
        ] },
        bashResult('bad', 'x'), bashResult('ok', 'y'),
      ],
    }])
    expect(recoverSubagentRuns(dir, 'subagent:')[0].bashCommands).toEqual(['好的'])
  })

  it('目录不存在 → 空数组，不抛出', () => {
    expect(recoverSubagentRuns('/tmp/绝不存在的目录-ab-subtrace', 'subagent:')).toEqual([])
  })

  it('目录里有坏 JSON 文件时跳过该文件，不整体失败', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ab-subtrace-bad-'))
    writeFileSync(path.join(dir, 'req-00001.json'), '{不是 JSON')
    writeFileSync(
      path.join(dir, 'req-00002.json'),
      JSON.stringify({ seq: 2, ts: '', label: 'subagent:verification', model: 'm',
        messages: [bashCall('t1', '好的'), bashResult('t1', 'r')], tools: [], params: {} }),
    )
    expect(recoverSubagentRuns(dir, 'subagent:')[0].bashCommands).toEqual(['好的'])
  })

  it('目录里的非 req-*.json 文件被忽略', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ab-subtrace-other-'))
    mkdirSync(path.join(dir, '子目录'))
    writeFileSync(path.join(dir, '随便.txt'), 'x')
    expect(recoverSubagentRuns(dir, 'subagent:')).toEqual([])
  })

  // ⊙ 新增：多 spawn 场景
  it('两次独立 spawn：messages 变短→新 spawn 开始（核心回归）', () => {
    const dir = mkTrace([
      // 第一次 spawn
      {
        seq: 1, label: 'subagent:verification',
        messages: [
          { role: 'system', content: 's' },
          { role: 'user', content: '修复失败' },
          bashCall('t1', '甲'),
          bashResult('t1', '退出码 1'),
        ],
      },
      // 第二次 spawn：新建 messages（length 短得多）
      {
        seq: 2, label: 'subagent:verification',
        messages: [
          { role: 'system', content: 's' },
          { role: 'user', content: '再试' },
          bashCall('t2', '乙'),
          bashResult('t2', 'PASS'),
        ],
      },
    ])
    const runs = recoverSubagentRuns(dir, 'subagent:')
    expect(runs).toHaveLength(2)
    expect(runs[0]).toEqual({ label: 'subagent:verification', bashCommands: ['甲'], bashResults: ['退出码 1'] })
    expect(runs[1]).toEqual({ label: 'subagent:verification', bashCommands: ['乙'], bashResults: ['PASS'] })
  })

  it('单次 spawn 内多轮累积：messages 递增→同一 spawn，返回最全的那条', () => {
    const dir = mkTrace([
      {
        seq: 1, label: 'subagent:verification',
        messages: [
          { role: 'system', content: 's' },
          { role: 'user', content: '修复' },
          bashCall('t1', '第一次'),
          bashResult('t1', 'r1'),
        ],
      },
      {
        seq: 2, label: 'subagent:verification',
        messages: [
          { role: 'system', content: 's' },
          { role: 'user', content: '修复' },
          bashCall('t1', '第一次'),
          bashResult('t1', 'r1'),
          bashCall('t2', '第二次'),
          bashResult('t2', 'r2'),
        ],
      },
    ])
    const runs = recoverSubagentRuns(dir, 'subagent:')
    expect(runs).toHaveLength(1)
    expect(runs[0].bashCommands).toEqual(['第一次', '第二次'])
  })

  it('三次 spawn：返回三条记录，顺序与 seq 一致', () => {
    const dir = mkTrace([
      { seq: 1, label: 'subagent:verification', messages: [
        { role: 'system', content: 's' },
        bashCall('t1', '甲'),
        bashResult('t1', 'r甲'),
      ] },
      { seq: 2, label: 'subagent:verification', messages: [
        { role: 'system', content: 's' },
        bashCall('t2', '乙'),
        bashResult('t2', 'r乙'),
      ] },
      { seq: 3, label: 'subagent:verification', messages: [
        { role: 'system', content: 's' },
        bashCall('t3', '丙'),
        bashResult('t3', 'r丙'),
      ] },
    ])
    const runs = recoverSubagentRuns(dir, 'subagent:')
    expect(runs).toHaveLength(3)
    expect(runs[0].bashCommands).toEqual(['甲'])
    expect(runs[1].bashCommands).toEqual(['乙'])
    expect(runs[2].bashCommands).toEqual(['丙'])
  })

  it('两次 spawn 但第二次 messages 等长于第一次→仍切成两条', () => {
    const msgs1 = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      bashCall('t1', '甲'),
      bashResult('t1', 'r甲'),
    ]
    const msgs2 = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      bashCall('t2', '乙'),
      bashResult('t2', 'r乙'),
    ]
    const dir = mkTrace([
      { seq: 1, label: 'subagent:verification', messages: msgs1 },
      { seq: 2, label: 'subagent:verification', messages: msgs2 }, // 长度相同，但仍是新 spawn
    ])
    const runs = recoverSubagentRuns(dir, 'subagent:')
    expect(runs).toHaveLength(2)
    expect(runs[0].bashCommands).toEqual(['甲'])
    expect(runs[1].bashCommands).toEqual(['乙'])
  })

  it('不同 label 各自独立切分，互不干扰', () => {
    const dir = mkTrace([
      { seq: 1, label: 'subagent:verification', messages: [
        { role: 'system', content: 's' },
        bashCall('t1', '甲'),
        bashResult('t1', 'r甲'),
      ] },
      { seq: 2, label: 'subagent:verification', messages: [
        { role: 'system', content: 's' },
        bashCall('t2', '乙'),
        bashResult('t2', 'r乙'),
      ] }, // seq=1,2 messages 都是 3 行，等长→各自一条
      { seq: 3, label: 'subagent:general', messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
        bashCall('t3', '丁'),
        bashResult('t3', 'r丁'),
      ] },
      { seq: 4, label: 'subagent:general', messages: [
        { role: 'system', content: 's' },
        bashCall('t4', '戊'),
        bashResult('t4', 'r戊'),
      ] }, // seq=3 是 4 行，seq=4 是 3 行，变短→各自一条
    ])
    const runs = recoverSubagentRuns(dir, 'subagent:').sort((x, y) => x.label.localeCompare(y.label))
    expect(runs).toHaveLength(4)
    expect(runs[0].label).toBe('subagent:general')
    expect(runs[0].bashCommands).toEqual(['丁']) // seq=3，general 第一个
    expect(runs[1].label).toBe('subagent:general')
    expect(runs[1].bashCommands).toEqual(['戊']) // seq=4，general 第二个（length 变短）
    expect(runs[2].label).toBe('subagent:verification')
    expect(runs[2].bashCommands).toEqual(['甲']) // seq=1，verification 第一个
    expect(runs[3].label).toBe('subagent:verification')
    expect(runs[3].bashCommands).toEqual(['乙']) // seq=2，verification 第二个（length 等长）
  })
})
