// test/backgroundSession.warning.test.ts —— 后台 job 的告警必须能被人看见
// 背景：后台子进程是 stdio:'ignore' 起的，console.error 直接进 /dev/null。
// 所以「model 被回落」这类配置被推翻的事实，必须落进 job state 并在 /stop 列表里显示，否则就是静默失效。
import { describe, it, expect } from 'vitest'
import { formatJobList, type JobState } from '../src/backgroundSession.js'

const job = (over: Partial<JobState> = {}): JobState => ({
  sessionId: 'abc', short: 'abc12345', state: 'working', cwd: '/tmp', name: '干活',
  pid: 1, model: 'deepseek-v4-flash', permMode: 'default', sessionFile: '/tmp/a.jsonl',
  createdAt: 0, updatedAt: 0, ...over,
} as JobState)

describe('formatJobList', () => {
  it('无告警时不额外输出', () => {
    const out = formatJobList([job()], 0)
    expect(out).toContain('abc12345')
    expect(out).not.toContain('⚠')
  })

  it('有告警时显示出来（后台 stderr 被丢弃，这是唯一的可见通道）', () => {
    const out = formatJobList([job({ warning: 'model=glm-5.2 不属于当前 provider（deepseek），已回落到 deepseek-v4-flash' })], 0)
    expect(out).toContain('⚠')
    expect(out).toContain('已回落到 deepseek-v4-flash')
  })
})
