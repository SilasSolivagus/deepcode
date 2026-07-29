import { describe, it, expect } from 'vitest'
import { createChatCore } from '../src/tui/useChat.js'
import { createPendingQueue } from '../src/tui/pendingQueue.js'
import type { Answer } from '../src/tools/askUserQuestion.js'

// 仅验证 pendingQuestion 桥的状态机契约：ChatState 暴露 pendingQuestion（初始 null），ChatCore 暴露 resolveQuestion。
describe('useChat AskUserQuestion 桥', () => {
  it('ChatState 暴露 pendingQuestion（初始 null），ChatCore 暴露 resolveQuestion', () => {
    const core = createChatCore({
      client: {} as any, yolo: false, cwd: '/tmp',
      sessionDir: '/tmp/dc-test-' + Math.random().toString(36).slice(2),
      onState: () => {},
    })
    expect(core.state.pendingQuestion).toBeNull()
    expect(typeof core.resolveQuestion).toBe('function')
  })
})

describe('question / planApproval 队列语义', () => {
  it('question 队列：并发两个都拿到应答，中断排空为 null', async () => {
    type Q = { resolve: (a: Answer[] | null) => void }
    const q = createPendingQueue<Answer[] | null, Q>(() => {})
    const p1 = new Promise<Answer[] | null>(res => q.push({ resolve: res }))
    const p2 = new Promise<Answer[] | null>(res => q.push({ resolve: res }))
    q.resolveHead([])
    q.drain(null)
    expect(await p1).toEqual([])
    expect(await p2).toBeNull()
  })

  it('planApproval 队列：中断排空为 false', async () => {
    type P = { resolve: (approved: boolean) => void }
    const q = createPendingQueue<boolean, P>(() => {})
    const p1 = new Promise<boolean>(res => q.push({ resolve: res }))
    q.drain(false)
    expect(await p1).toBe(false)
  })

  it('ChatState 仍暴露 pendingQuestion（初始 null）与 pendingAskCount（初始 0）', () => {
    const core = createChatCore({
      client: {} as any, yolo: false, cwd: '/tmp',
      sessionDir: '/tmp/dc-test-' + Math.random().toString(36).slice(2),
      onState: () => {},
    })
    expect(core.state.pendingQuestion).toBeNull()
    expect(core.state.pendingAskCount).toBe(0)
    expect(typeof core.resolvePlanApproval).toBe('function')
  })
})
