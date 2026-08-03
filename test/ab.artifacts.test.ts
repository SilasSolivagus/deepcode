import { describe, it, expect } from 'vitest'
import { extractArtifacts } from '../bench/ab/artifacts.js'
import { streamFromLoopEvent } from '../src/streamJson.js'

const line = (o: unknown) => JSON.stringify(o)

const TRACE = [
  line({ type: 'init', session_id: 's', cwd: '/x', model: 'm', yolo: true }),
  line({ type: 'tool_start', id: 't1', name: 'Bash', input: { command: 'npm install' } }),
  line({ type: 'tool_result', id: 't1', ok: true, content: '…', ms: 12 }),
  line({ type: 'tool_start', id: 't2', name: 'Read', input: { file_path: '/x/a.ts' } }),
  line({ type: 'tool_start', id: 't3', name: 'Bash', input: { command: 'node dist/cli.js stats f.jsonl 2>&1 | tail -5' } }),
  line({ type: 'turn_end', usage: { prompt_tokens: 100 } }),
  line({ type: 'result', status: 'max_turns', turns: 80, usage: {}, costCNY: 0.3, text: '…' }),
].join('\n')

describe('extractArtifacts', () => {
  it('只抽 Bash 的命令原文，按出现顺序', () => {
    const a = extractArtifacts({ traceJsonl: TRACE, exitCode: 1, outputDir: '/out' })
    expect(a.bashCommands).toEqual([
      'npm install',
      'node dist/cli.js stats f.jsonl 2>&1 | tail -5',
    ])
  })

  it('从 result 事件取 status 与 turns', () => {
    const a = extractArtifacts({ traceJsonl: TRACE, exitCode: 1, outputDir: '/out' })
    expect(a.status).toBe('max_turns')
    expect(a.turns).toBe(80)
  })

  it('原样带上 exitCode 与 outputDir', () => {
    const a = extractArtifacts({ traceJsonl: TRACE, exitCode: 1, outputDir: '/out' })
    expect(a.exitCode).toBe(1)
    expect(a.outputDir).toBe('/out')
  })

  it('轨迹里有坏行时跳过该行，不整体失败', () => {
    const withBad = TRACE + '\n{不是 JSON\n' + line({ type: 'tool_start', id: 't4', name: 'Bash', input: { command: 'echo ok' } })
    const a = extractArtifacts({ traceJsonl: withBad, exitCode: 0, outputDir: '/out' })
    expect(a.bashCommands).toContain('echo ok')
  })

  it('空轨迹：命令为空、status 记为 unknown、turns 为 0', () => {
    const a = extractArtifacts({ traceJsonl: '', exitCode: 1, outputDir: '/out' })
    expect(a.bashCommands).toEqual([])
    expect(a.status).toBe('unknown')
    expect(a.turns).toBe(0)
  })

  it('契约测试：streamFromLoopEvent 生成的真实 tool_start 事件能被正确解析', () => {
    // 这条测试锁住两个模块的契约：如果 streamFromLoopEvent 的输出形状变了，
    // 或者 extractArtifacts 对事件形状的假设变了，这条测试会立刻变红。
    // 不靠手写 JSON 字面量，而是用真实的事件生成函数，确保契约在代码变更时被验证。

    const toolStartEvent: any = {
      type: 'tool_start',
      id: 'test-bash-1',
      name: 'Bash',
      desc: JSON.stringify({ command: 'echo hello from contract test' }),
    }

    const serialized = streamFromLoopEvent(toolStartEvent)
    expect(serialized).not.toBeNull()

    // streamFromLoopEvent 输出的是一行 JSONL（末尾带 \n），先去掉
    const jsonLine = serialized!.trim()
    const parsed = JSON.parse(jsonLine)

    // 组织成 extractArtifacts 能吃的轨迹形式
    const traceJsonl = jsonLine

    const artifacts = extractArtifacts({ traceJsonl, exitCode: 0, outputDir: '/test' })
    expect(artifacts.bashCommands).toContain('echo hello from contract test')
  })
})

const line2 = (o: unknown) => JSON.stringify(o)

const RICH = [
  line2({ type: 'init', session_id: 's', cwd: '/x', model: 'm', yolo: true }),
  line2({ type: 'tool_start', id: 'a', name: 'Bash', input: { command: 'npm test' } }),
  line2({ type: 'tool_result', id: 'a', ok: true, content: '退出码 1\nFAIL 3 tests', ms: 5 }),
  line2({ type: 'tool_start', id: 'b', name: 'Edit', input: { file_path: '/x/one.ts' } }),
  line2({ type: 'tool_result', id: 'b', ok: true, content: 'ok', ms: 1 }),
  line2({ type: 'tool_start', id: 'c', name: 'Write', input: { file_path: '/x/two.ts' } }),
  line2({ type: 'tool_result', id: 'c', ok: true, content: 'ok', ms: 1 }),
  line2({ type: 'tool_start', id: 'd', name: 'NotebookEdit', input: { notebook_path: '/x/n.ipynb' } }),
  line2({ type: 'tool_result', id: 'd', ok: true, content: 'ok', ms: 1 }),
  line2({ type: 'tool_start', id: 'e', name: 'Agent', input: { subagent_type: 'verification', prompt: 'verify' } }),
  line2({ type: 'tool_result', id: 'e', ok: true, content: '### 检查：x\n**跑了什么命令：**\n  npm test\n**看到什么输出：**\n  ok\n\nVERDICT: FAIL', ms: 9 }),
  line2({ type: 'tool_start', id: 'f', name: 'Bash', input: { command: 'npm test' } }),
  line2({ type: 'tool_result', id: 'f', ok: true, content: '全部通过', ms: 5 }),
  line2({ type: 'result', status: 'done', turns: 7, usage: {}, costCNY: 0.3, text: '…' }),
].join('\n')

describe('extractArtifacts 新增字段', () => {
  const a = () => extractArtifacts({ traceJsonl: RICH, exitCode: 0, outputDir: '/out' })

  it('bashResults 按顺序带上结果原文与 seq', () => {
    expect(a().bashResults).toEqual([
      { content: '退出码 1\nFAIL 3 tests', seq: 0 },
      { content: '全部通过', seq: 5 },
    ])
  })

  it('editedFiles 覆盖 Edit/Write/NotebookEdit 三种工具的三种参数名', () => {
    expect(a().editedFiles).toEqual([
      { path: '/x/one.ts', seq: 1 },
      { path: '/x/two.ts', seq: 2 },
      { path: '/x/n.ipynb', seq: 3 },
    ])
  })

  it('agentSpawns 抽出 subagent_type、verdict 与报告原文', () => {
    const s = a().agentSpawns
    expect(s).toHaveLength(1)
    expect(s[0].subagentType).toBe('verification')
    expect(s[0].verdict).toBe('FAIL')
    expect(s[0].seq).toBe(4)
    expect(s[0].report).toContain('**跑了什么命令：**')
  })

  it('bashCommands 保持原样（既有判定器依赖它）', () => {
    expect(a().bashCommands).toEqual(['npm test', 'npm test'])
  })

  it('省略 subagent_type 时记为 general-purpose', () => {
    const t = [
      line2({ type: 'tool_start', id: 'g', name: 'Agent', input: { prompt: 'x' } }),
      line2({ type: 'tool_result', id: 'g', ok: true, content: '没有 verdict 行', ms: 1 }),
    ].join('\n')
    const s = extractArtifacts({ traceJsonl: t, exitCode: 0, outputDir: '/o' }).agentSpawns
    expect(s[0].subagentType).toBe('general-purpose')
  })

  it('报告里没有 VERDICT 行时 verdict 记 null（是数据，不是尺子坏了）', () => {
    const t = [
      line2({ type: 'tool_start', id: 'g', name: 'Agent', input: { subagent_type: 'verification' } }),
      line2({ type: 'tool_result', id: 'g', ok: true, content: '我觉得挺好的', ms: 1 }),
    ].join('\n')
    expect(extractArtifacts({ traceJsonl: t, exitCode: 0, outputDir: '/o' }).agentSpawns[0].verdict).toBeNull()
  })

  it('VERDICT 必须独占一行才算数（防止正文里提到这个词被误抽）', () => {
    const t = [
      line2({ type: 'tool_start', id: 'g', name: 'Agent', input: { subagent_type: 'verification' } }),
      line2({ type: 'tool_result', id: 'g', ok: true, content: '我准备写 VERDICT: PASS 但还没决定', ms: 1 }),
    ].join('\n')
    expect(extractArtifacts({ traceJsonl: t, exitCode: 0, outputDir: '/o' }).agentSpawns[0].verdict).toBeNull()
  })

  it('没有对应 tool_result 的调用不产出记录（轨迹被截断的跑）', () => {
    const t = line2({ type: 'tool_start', id: 'h', name: 'Agent', input: { subagent_type: 'verification' } })
    const r = extractArtifacts({ traceJsonl: t, exitCode: 1, outputDir: '/o' })
    expect(r.agentSpawns).toEqual([])
  })

  it('空轨迹：三个新字段都是空数组', () => {
    const r = extractArtifacts({ traceJsonl: '', exitCode: 1, outputDir: '/o' })
    expect(r.bashResults).toEqual([])
    expect(r.editedFiles).toEqual([])
    expect(r.agentSpawns).toEqual([])
  })
})

describe('I4：VERDICT 抽取对常见格式偏差容错', () => {
  const withVerdict = (content: string) => {
    const t = [
      line2({ type: 'tool_start', id: 'v', name: 'Agent', input: { subagent_type: 'verification' } }),
      line2({ type: 'tool_result', id: 'v', ok: true, content, ms: 1 }),
    ].join('\n')
    return extractArtifacts({ traceJsonl: t, exitCode: 0, outputDir: '/o' }).agentSpawns[0]
  }

  it('规范格式', () => {
    const s = withVerdict('VERDICT: PASS')
    expect(s.verdict).toBe('PASS')
    expect(s.sawVerdictLine).toBe(true)
  })

  it('行尾多一个空格', () => {
    expect(withVerdict('VERDICT: PASS ').verdict).toBe('PASS')
  })

  it('被加粗（提示词明令禁止但模型常犯）', () => {
    expect(withVerdict('**VERDICT: PASS**').verdict).toBe('PASS')
  })

  it('冒号后两个空格', () => {
    expect(withVerdict('VERDICT:  PASS').verdict).toBe('PASS')
  })

  it('末尾带句号', () => {
    expect(withVerdict('VERDICT: PASS.').verdict).toBe('PASS')
  })

  it('出现 VERDICT 但格式不合法 → verdict=null 且 sawVerdictLine=true', () => {
    const s = withVerdict('我的最终 VERDICT 还没想好，容我再想想。')
    expect(s.verdict).toBeNull()
    expect(s.sawVerdictLine).toBe(true)
  })

  it('压根没提 VERDICT → verdict=null 且 sawVerdictLine=false（与「格式偏了」区分开）', () => {
    const s = withVerdict('看起来都挺好的。')
    expect(s.verdict).toBeNull()
    expect(s.sawVerdictLine).toBe(false)
  })
})

import { mkdtempSync as mkdtemp2, writeFileSync as write2 } from 'node:fs'
import { tmpdir as tmpdir2 } from 'node:os'
import path2 from 'node:path'

describe('extractArtifacts 接子代理轨迹', () => {
  const mkTraceDir = () => {
    const dir = mkdtemp2(path2.join(tmpdir2(), 'ab-art-sub-'))
    write2(path2.join(dir, 'req-00001.json'), JSON.stringify({
      seq: 1, ts: '', label: 'subagent:verification', model: 'm', tools: [], params: {},
      messages: [
        { role: 'assistant', content: null, tool_calls: [
          { id: 't1', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'npm test' }) } },
        ] },
        { role: 'tool', tool_call_id: 't1', content: '退出码 1\nFAIL' },
      ],
    }))
    return dir
  }

  it('不传 traceDir 时 subagentRuns 为空数组（既有调用方不受影响）', () => {
    const a = extractArtifacts({ traceJsonl: '', exitCode: 0, outputDir: '/o' })
    expect(a.subagentRuns).toEqual([])
  })

  it('传了 traceDir 就恢复出子代理跑过的命令', () => {
    const a = extractArtifacts({ traceJsonl: '', exitCode: 0, outputDir: '/o', traceDir: mkTraceDir() })
    expect(a.subagentRuns).toHaveLength(1)
    expect(a.subagentRuns[0].label).toBe('subagent:verification')
    expect(a.subagentRuns[0].bashCommands).toEqual(['npm test'])
    expect(a.subagentRuns[0].bashResults).toEqual(['退出码 1\nFAIL'])
  })

  it('traceDir 指向不存在的目录时不抛出，subagentRuns 为空', () => {
    const a = extractArtifacts({ traceJsonl: '', exitCode: 0, outputDir: '/o', traceDir: '/tmp/绝不存在-ab-art' })
    expect(a.subagentRuns).toEqual([])
  })

  it('子代理的命令不混进 bashCommands（那是主代理的语义）', () => {
    const a = extractArtifacts({ traceJsonl: '', exitCode: 0, outputDir: '/o', traceDir: mkTraceDir() })
    expect(a.bashCommands).toEqual([])
    expect(a.bashResults).toEqual([])
  })
})
