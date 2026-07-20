import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:child_process', async importOriginal => {
  const cp = await importOriginal<typeof import('node:child_process')>()
  return {
    ...cp,
    execSync: vi.fn(),
  }
})

import { buildCommitGuidance, buildCommitPushPrGuidance, resolveAttribution, DEFAULT_ATTR_COMMIT, DEFAULT_ATTR_PR, buildCommitContext, buildPrContext, isEmptyDiff, resolveBaseBranch, formatDiffView } from '../src/commitGuidance.js'
import { execSync } from 'node:child_process'

describe('resolveAttribution', () => {
  it('缺省 → deepcode 内置两文案', () => {
    expect(resolveAttribution({})).toEqual({ commit: DEFAULT_ATTR_COMMIT, pr: DEFAULT_ATTR_PR })
  })
  it('includeCoAuthoredBy:false → 两者清空', () => {
    expect(resolveAttribution({ includeCoAuthoredBy: false })).toEqual({ commit: '', pr: '' })
  })
  it('attribution.commit 覆盖、pr 回落默认', () => {
    expect(resolveAttribution({ attribution: { commit: 'X' } })).toEqual({ commit: 'X', pr: DEFAULT_ATTR_PR })
  })
  it('attribution.commit 空串 = 隐藏 commit、pr 仍默认（优先于 includeCoAuthoredBy）', () => {
    expect(resolveAttribution({ attribution: { commit: '' }, includeCoAuthoredBy: false }))
      .toEqual({ commit: '', pr: DEFAULT_ATTR_PR })
  })
})

describe('buildCommitGuidance', () => {
  const g = buildCommitGuidance({ commit: DEFAULT_ATTR_COMMIT })
  it('含 6 条 Safety Protocol 关键词', () => {
    for (const k of ['git config', '--no-verify', '--amend', '.env', '空 commit', '-i']) expect(g).toContain(k)
  })
  it('含风格编排 + HEREDOC + add 语义 + 验证', () => {
    expect(g).toContain('风格'); expect(g).toContain('HEREDOC'); expect(g).toContain('add'); expect(g).toContain('确认成功')
  })
  it('默认含 trailer', () => { expect(g).toContain('Co-Authored-By: deepcode <noreply@dirctable.com>') })
  it('commit body 不含 Generated with / 🤖', () => { expect(g).not.toContain('Generated with'); expect(g).not.toContain('🤖') })
  it('commit 空串 → 不含 trailer', () => { expect(buildCommitGuidance({ commit: '' })).not.toContain('Co-Authored-By') })
  it('末尾纯调工具', () => { expect(g).toContain('不要发送任何其它文字') })
})

describe('buildCommitPushPrGuidance', () => {
  const g = buildCommitPushPrGuidance({ commit: DEFAULT_ATTR_COMMIT, pr: DEFAULT_ATTR_PR })
  it('含 force-push main 红线 + gh 二分 + PR 模板', () => {
    expect(g).toContain('force-push 到 main'); expect(g).toContain('gh pr edit'); expect(g).toContain('gh pr create')
    expect(g).toContain('## Summary'); expect(g).toContain('## Test plan'); expect(g).toContain('## Changelog')
    expect(g).toContain('不只是最新')
  })
  it('默认含 commit trailer + PR 署名', () => {
    expect(g).toContain('Co-Authored-By: deepcode <noreply@dirctable.com>'); expect(g).toContain('🤖 由 deepcode 生成')
  })
  it('pr 空串 → 不含 🤖；commit 空串 → 不含 trailer', () => {
    const empty = buildCommitPushPrGuidance({ commit: '', pr: '' })
    expect(empty).not.toContain('🤖'); expect(empty).not.toContain('Co-Authored-By')
  })
})

describe('buildCommitContext', () => {
  it('用 <git-context> 包裹且含四段输出', () => {
    const c = buildCommitContext({ status: 'ST', diff: 'DF', branch: 'BR', log: 'LG' })
    expect(c.startsWith('<git-context>')).toBe(true)
    expect(c.trimEnd().endsWith('</git-context>')).toBe(true)
    expect(c).toContain('ST')
    expect(c).toContain('DF')
    expect(c).toContain('BR')
    expect(c).toContain('LG')
  })
})

describe('buildPrContext', () => {
  it('含 base diff 段与已存在 PR 段', () => {
    const c = buildPrContext({ status: 'ST', diff: 'DF', branch: 'BR', baseDiff: 'BD', existingPr: 'PR' })
    expect(c.startsWith('<git-context>')).toBe(true)
    expect(c).toContain('BD')
    expect(c).toContain('PR')
    expect(c).toContain('ST')
    expect(c).toContain('DF')
    expect(c).toContain('BR')
  })
})

describe('isEmptyDiff', () => {
  it('空串/纯空白→true', () => {
    expect(isEmptyDiff('')).toBe(true)
    expect(isEmptyDiff('   \n  ')).toBe(true)
  })
  it('有内容→false', () => {
    expect(isEmptyDiff(' M src/x.ts')).toBe(false)
  })
})

describe('formatDiffView (/diff)', () => {
  it('status + diff 拼成可读文本', () => {
    const out = formatDiffView(' M src/x.ts\n', 'diff --git a/x b/x\n+新增行\n')
    expect(out).toContain('未提交改动：')
    expect(out).toContain(' M src/x.ts')
    expect(out).toContain('+新增行')
  })
  it('只有 status、diff 空（如仅未跟踪文件）→ 只显 status 段', () => {
    const out = formatDiffView('?? new.ts\n', '')
    expect(out).toContain('?? new.ts')
    expect(out.trim().endsWith('?? new.ts')).toBe(true)
  })
  it('过长 diff 截断并提示', () => {
    const big = 'x'.repeat(9000)
    const out = formatDiffView(' M a', big, 8000)
    expect(out.length).toBeLessThan(8000 + 200)
    expect(out).toContain('diff 过长已截断')
    expect(out).toContain('9000 字符')
  })
})

describe('resolveBaseBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('解析 symbolic-ref 末段', () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from('refs/remotes/origin/develop\n'))
    expect(resolveBaseBranch('/x')).toBe('develop')
  })
  it('execSync throw → 回退 main', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('no origin/HEAD') })
    expect(resolveBaseBranch('/x')).toBe('main')
  })
})
