import { describe, it, expect, vi } from 'vitest'

const script: Array<{ result: any } | { throw: true }> = []
vi.mock('../src/api.js', () => ({
  chatStream: vi.fn((_client: any, opts: any) => (async function* () {
    if (opts?.signal?.aborted) throw new Error('aborted')
    const scene = script.shift(); if (!scene) throw new Error('script exhausted')
    if ('throw' in scene) throw new Error('boom')
    return scene.result
  })()),
}))

import { parseGoalVerdict, runGoalJudge, GOAL_JUDGE_SYSTEM, GOAL_CLEAR_WORDS, goalDirective, goalJudgeUser } from '../src/goal.js'
const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }

describe('parseGoalVerdict', () => {
  it('ok:true', () => { expect(parseGoalVerdict('{"ok":true,"reason":"done"}')).toEqual({ ok: true, reason: 'done', impossible: false }) })
  it('ok:false', () => { expect(parseGoalVerdict('{"ok":false,"reason":"missing"}')).toEqual({ ok: false, reason: 'missing', impossible: false }) })
  it('impossible', () => { expect(parseGoalVerdict('{"ok":false,"impossible":true,"reason":"x"}')).toEqual({ ok: false, reason: 'x', impossible: true }) })
  it('JSON 埋在散文里也能抽', () => { expect(parseGoalVerdict('好的\n{"ok":true}\n以上')).toEqual({ ok: true, reason: undefined, impossible: false }) })
  it('malformed → null', () => { expect(parseGoalVerdict('{ok true')).toBe(null) })
  it('缺 ok → null', () => { expect(parseGoalVerdict('{"reason":"x"}')).toBe(null) })
  it('非 JSON → null', () => { expect(parseGoalVerdict('随便一句话')).toBe(null) })
})

describe('runGoalJudge', () => {
  it('合法 verdict 透传', async () => {
    script.push({ result: { content: '{"ok":false,"reason":"still failing"}', usage, finishReason: 'stop' } })
    const v = await runGoalJudge({} as any, [{ role: 'user', content: 'x' }], '让测试通过', 'deepseek-v4-flash', new AbortController().signal)
    expect(v).toEqual({ ok: false, reason: 'still failing', impossible: false })
  })
  it('malformed 输出 → error（放行）', async () => {
    script.push({ result: { content: '我觉得差不多了', usage, finishReason: 'stop' } })
    expect(await runGoalJudge({} as any, [{ role: 'user', content: 'x' }], 'c', 'deepseek-v4-flash', new AbortController().signal)).toBe('error')
  })
  it('调用抛异常 → error（放行）', async () => {
    script.push({ throw: true })
    expect(await runGoalJudge({} as any, [{ role: 'user', content: 'x' }], 'c', 'deepseek-v4-flash', new AbortController().signal)).toBe('error')
  })
  it('传入已 abort 的 signal → 立即 error（不发真实请求）', async () => {
    script.push({ result: { content: '{"ok":true}', usage, finishReason: 'stop' } }) // 守卫失效会消费它返回 verdict → 非 error
    const ac = new AbortController(); ac.abort()
    const v = await runGoalJudge({} as any, [{ role: 'user', content: 'x' }], 'c', 'deepseek-v4-flash', ac.signal)
    expect(v).toBe('error')
  })
})

describe('常量/文案', () => {
  it('judge system 含 impossible 语义', () => { expect(GOAL_JUDGE_SYSTEM).toMatch(/impossible/) })
  it('清除词表', () => { expect(GOAL_CLEAR_WORDS.has('clear')).toBe(true); expect(GOAL_CLEAR_WORDS.has('stop')).toBe(true) })
  it('directive/judgeUser 带入条件', () => { expect(goalDirective('C')).toContain('C'); expect(goalJudgeUser('C')).toContain('C') })
})
