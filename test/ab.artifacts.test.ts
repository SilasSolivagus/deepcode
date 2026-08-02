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
