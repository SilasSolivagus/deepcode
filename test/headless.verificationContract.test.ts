// test/headless.verificationContract.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { VERIFICATION_CONTRACT, buildSystemPrompt } from '../src/prompt.js'

describe('VERIFICATION_CONTRACT 正文', () => {
  it('点名子代理类型，主代理才知道要派谁', () => {
    expect(VERIFICATION_CONTRACT).toContain('verification')
  })
  it('判定权归验证者独占', () => {
    expect(VERIFICATION_CONTRACT).toContain('判定权')
  })
  it('讲明没有 resume，FAIL 后要再派一个新的验证者', () => {
    expect(VERIFICATION_CONTRACT).toContain('新的验证者')
  })
  it('PASS 之后要抽查重跑对账', () => {
    expect(VERIFICATION_CONTRACT).toContain('重跑')
  })
  it('终态诚实：没拿到 PASS 不得自评完成', () => {
    expect(VERIFICATION_CONTRACT).toContain('不得自评完成')
  })
})

describe('合同绝不进 buildSystemPrompt（结构上保证 TUI 碰不到）', () => {
  const ORIG = process.env.DEEPCODE_FLAGS
  afterEach(() => {
    if (ORIG === undefined) delete process.env.DEEPCODE_FLAGS
    else process.env.DEEPCODE_FLAGS = ORIG
  })

  it('flag 关：系统提示词不含合同', () => {
    delete process.env.DEEPCODE_FLAGS
    expect(buildSystemPrompt('/tmp', '/tmp/nonexistent-home')).not.toContain('判定权')
  })

  it('flag 开：系统提示词**仍然**不含合同——它只由 headless 追加', () => {
    process.env.DEEPCODE_FLAGS = '{"verificationAgent":true}'
    expect(buildSystemPrompt('/tmp', '/tmp/nonexistent-home')).not.toContain('判定权')
  })
})
