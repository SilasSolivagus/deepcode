import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createActivityWriter, sessionStartedAt } from '../src/memdir/activityLog.js'

let dir: string
const WHEN = new Date(2026, 6, 13, 10, 0, 0)
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'act-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const mk = (over: any = {}) => createActivityWriter({
  memdir: () => dir,
  sessionId: 'sess-1',
  meta: { cwd: '/repo', model: 'glm-5.2' },
  enabled: () => true,
  now: () => WHEN,
  ...over,
})
const logFile = (slug: string) => path.join(dir, 'logs/2026/07/13', `sess-1-${slug}.md`)
const read = (slug: string) => fs.readFileSync(logFile(slug), 'utf8')

describe('懒创建 + frontmatter + slug', () => {
  it('未写入任何行时不创建文件', () => {
    mk()
    expect(fs.existsSync(path.join(dir, 'logs'))).toBe(false)
  })

  it('首条用户消息触发创建，slug 取自首条消息，含 frontmatter', () => {
    const w = mk()
    w.onMessage({ role: 'user', content: '修一下登录 bug' }, 1)
    const txt = read('修一下登录-bug')
    expect(txt).toContain('session: sess-1')
    expect(txt).toContain('cwd: /repo')
    expect(txt).toContain('model: glm-5.2')
    expect(txt).toContain('> 修一下登录 bug')
  })

  it('parent 写入 frontmatter（fork/clear/background 派生）', () => {
    const w = mk({ meta: { cwd: '/repo', model: 'm', parent: 'sess-0' } })
    w.onMessage({ role: 'user', content: 'hi' }, 1)
    expect(read('hi')).toContain('parent: sess-0')
  })
})

describe('消息判别（fail-closed）', () => {
  it('system 消息不写', () => {
    const w = mk()
    w.onMessage({ role: 'system', content: '巨大的系统提示' })
    expect(fs.existsSync(path.join(dir, 'logs'))).toBe(false)
  })

  it('无 turnId 的合成 user 消息全部跳过', () => {
    const w = mk()
    w.onMessage({ role: 'user', content: '真实输入' }, 1)   // 建文件
    w.onMessage({ role: 'user', content: '（继续——尚未达到本次 token 预算，请接着完成未尽工作，不要总结收尾。）' })
    w.onMessage({ role: 'user', content: 'The PermissionDenied hook indicated you may retry this tool call.' })
    w.onMessage({ role: 'user', content: '<git-context>\n## 当前 git 状态\nM src/a.ts\n</git-context>' })
    const txt = read('真实输入')
    expect(txt).not.toContain('token 预算')
    expect(txt).not.toContain('PermissionDenied')
    expect(txt).not.toContain('git-context')
    expect(txt.match(/^> /gm)!.length).toBe(1)
  })

  // useChat.ts:1282 的上下文 thrashing 警告：整条消息就是一个 <system-reminder>，无 turnId
  it('thrashing 警告（system-reminder 整条、无 turnId）不产生任何 > 行', () => {
    const w = mk()
    w.onMessage({ role: 'user', content: '真实输入' }, 1)
    w.onMessage({
      role: 'user',
      content: '<system-reminder>\n上下文反复被填满（thrashing）。请停止重复读取大文件/大工具输出，改为分块读取，或提示用户用 /clear。\n</system-reminder>',
    })
    const txt = read('真实输入')
    expect(txt).not.toContain('thrashing')
    expect(txt).not.toContain('system-reminder')
    expect(txt.match(/^> /gm)!.length).toBe(1)
  })

  it('steering（无 turnId）拆出内层原文当作用户话轮', () => {
    const w = mk()
    w.onMessage({ role: 'user', content: 'go' }, 1)
    w.onMessage({ role: 'user', content: '<queued-user-message>\n用户在你执行过程中补充了这条消息（在你看到它之前已发出）。请据此调整当前工作：\n先跑测试\n</queued-user-message>' })
    expect(read('go')).toContain('> 先跑测试')
  })

  it('bang 命令写成工具行，不当用户话轮', () => {
    const w = mk()
    w.onMessage({ role: 'user', content: 'go' }, 1)
    w.onMessage({ role: 'user', content: '<bash-input>npm test</bash-input>\n<bash-output>\nok\n</bash-output>' })
    const txt = read('go')
    expect(txt).toContain('. !npm test')
    expect(txt.match(/^> /gm)!.length).toBe(1)
  })

  it('助手中途叙述（带 tool_calls）整行丢弃，只留结论', () => {
    const w = mk()
    w.onMessage({ role: 'user', content: 'go' }, 1)
    w.onMessage({ role: 'assistant', content: '好，先搜一下：', tool_calls: [
      { id: 't1', function: { name: 'Grep', arguments: '{"pattern":"风控"}' } },
    ] })
    w.onMessage({ role: 'tool', tool_call_id: 't1', content: '命中 3 处' })
    w.onMessage({ role: 'assistant', content: '结论：共 5 个模块。' })
    const txt = read('go')
    expect(txt).not.toContain('好，先搜一下')
    expect(txt).toContain('< 结论：共 5 个模块。')
  })
})

describe('工具行：只记非只读与失败', () => {
  const isRO = (n: string) => ['Read', 'Grep', 'Glob'].includes(n)

  it('只读工具成功 → 不写（占全部调用 60.4%，零信息）', () => {
    const w = mk({ isReadOnly: isRO, toolOk: () => true })
    w.onMessage({ role: 'user', content: 'go' }, 1)
    w.onMessage({ role: 'assistant', content: null, tool_calls: [
      { id: 't1', function: { name: 'Read', arguments: '{"file_path":"a.ts"}' } },
    ] })
    w.onMessage({ role: 'tool', tool_call_id: 't1', content: '文件内容' })
    expect(read('go')).not.toContain('. Read')
  })

  it('只读工具失败 → 要写', () => {
    const w = mk({ isReadOnly: isRO, toolOk: () => false })
    w.onMessage({ role: 'user', content: 'go' }, 1)
    w.onMessage({ role: 'assistant', content: null, tool_calls: [
      { id: 't1', function: { name: 'Read', arguments: '{"file_path":"nope.ts"}' } },
    ] })
    w.onMessage({ role: 'tool', tool_call_id: 't1', content: '错误：文件不存在' })
    expect(read('go')).toContain('. Read(nope.ts) ✗ 错误：文件不存在')
  })

  it('非只读工具成功 → 要写', () => {
    const w = mk({ isReadOnly: isRO, toolOk: () => true })
    w.onMessage({ role: 'user', content: 'go' }, 1)
    w.onMessage({ role: 'assistant', content: null, tool_calls: [
      { id: 't1', function: { name: 'Edit', arguments: '{"file_path":"src/a.ts"}' } },
    ] })
    w.onMessage({ role: 'tool', tool_call_id: 't1', content: '已编辑' })
    expect(read('go')).toContain('. Edit(src/a.ts) ✓')
  })

  it('只读工具 ok===undefined（resume 合成的 tool 消息）→ 不写', () => {
    const w = mk({ isReadOnly: isRO, toolOk: () => undefined })
    w.onMessage({ role: 'user', content: 'go' }, 1)
    w.onMessage({ role: 'assistant', content: null, tool_calls: [
      { id: 't1', function: { name: 'Grep', arguments: '{"pattern":"x"}' } },
    ] })
    w.onMessage({ role: 'tool', tool_call_id: 't1', content: '（中断）' })
    expect(read('go')).not.toContain('. Grep')
  })

  it('非只读工具 ok===undefined → 写，但不画成败符号', () => {
    const w = mk({ isReadOnly: isRO, toolOk: () => undefined })
    w.onMessage({ role: 'user', content: 'go' }, 1)
    w.onMessage({ role: 'assistant', content: null, tool_calls: [
      { id: 't1', function: { name: 'Bash', arguments: '{"command":"npm test"}' } },
    ] })
    w.onMessage({ role: 'tool', tool_call_id: 't1', content: '（中断）' })
    const txt = read('go')
    expect(txt).toContain('. Bash(npm test)')
    expect(txt).not.toContain('✓')
    expect(txt).not.toContain('✗')
  })

  it('无匹配 pending 的 tool 消息（孤儿）不写', () => {
    const w = mk({ isReadOnly: isRO, toolOk: () => true })
    w.onMessage({ role: 'user', content: 'go' }, 1)
    w.onMessage({ role: 'tool', tool_call_id: 'ghost', content: '结果' })
    expect(read('go').match(/^\. /gm)).toBe(null)
  })

  it('连续相同工具行折叠为 ×N', () => {
    const w = mk({ isReadOnly: isRO, toolOk: () => false })
    w.onMessage({ role: 'user', content: 'go' }, 1)
    for (let i = 0; i < 3; i++) {
      w.onMessage({ role: 'assistant', content: null, tool_calls: [
        { id: `t${i}`, function: { name: 'Read', arguments: '{"file_path":"x.ts"}' } },
      ] })
      w.onMessage({ role: 'tool', tool_call_id: `t${i}`, content: '错误：文件不存在' })
    }
    const txt = read('go')
    expect(txt).toContain('×3')
    expect(txt.match(/^\. Read/gm)!.length).toBe(1)
  })

  it('折叠不破坏前后行，且被不同行打断后重新计数', () => {
    const w = mk({ isReadOnly: isRO, toolOk: () => true })
    w.onMessage({ role: 'user', content: '中文标题够长以覆盖多字节偏移' }, 1)
    const call = (id: string, name: string, args: string) => {
      w.onMessage({ role: 'assistant', content: null, tool_calls: [{ id, function: { name, arguments: args } }] })
      w.onMessage({ role: 'tool', tool_call_id: id, content: '好' })
    }
    call('a1', 'Edit', '{"file_path":"src/a.ts"}')
    call('a2', 'Edit', '{"file_path":"src/a.ts"}')
    call('b1', 'Write', '{"file_path":"src/b.ts"}')
    call('a3', 'Edit', '{"file_path":"src/a.ts"}')
    const body = read('中文标题够长以覆盖多字节偏移').split('---\n')[2]
    expect(body.trim().split('\n')).toEqual([
      '> 中文标题够长以覆盖多字节偏移',
      '. Edit(src/a.ts) ✓ ×2',
      '. Write(src/b.ts) ✓',
      '. Edit(src/a.ts) ✓',
    ])
  })

  it('用户多行消息里的相同行不折叠（保真）', () => {
    const w = mk()
    w.onMessage({ role: 'user', content: '重复\n重复' }, 1)   // slugify 先剥控制字符 → slug 无分隔
    expect(read('重复重复').match(/^> 重复$/gm)!.length).toBe(2)
  })
})

describe('displayText 侧信道（斜杠命令 userText ≠ 用户说的话）', () => {
  const COMMIT_GUIDANCE = '请检查 git 状态，暂存所有相关改动，写一条清晰的中文提交信息并提交。不要包含无关文件。'

  it('displayText 返回字符串时，> 行用它而不是 m.content', () => {
    const w = mk({ displayText: (m: any) => (m.content === COMMIT_GUIDANCE ? '/commit' : undefined) })
    w.onMessage({ role: 'user', content: COMMIT_GUIDANCE }, 1)
    const txt = read('commit')
    expect(txt).toContain('> /commit')
    expect(txt).not.toContain('请检查 git 状态')
    expect(txt).not.toContain(COMMIT_GUIDANCE)
  })

  it('displayText 返回 undefined 时，退回 m.content', () => {
    const w = mk({ displayText: () => undefined })
    w.onMessage({ role: 'user', content: '真实用户输入' }, 1)
    expect(read('真实用户输入')).toContain('> 真实用户输入')
  })

  it('不传 displayText 选项时，行为与之前完全一致', () => {
    const w = mk()
    w.onMessage({ role: 'user', content: '真实用户输入' }, 1)
    expect(read('真实用户输入')).toContain('> 真实用户输入')
  })
})

describe('事件标记', () => {
  it('event() 写 ~ 行', () => {
    const w = mk()
    w.onMessage({ role: 'user', content: 'go' }, 1)
    w.event('compact')
    expect(read('go')).toContain('~ compact')
  })

  it('文件尚未创建时 event() 静默丢弃、不建文件', () => {
    const w = mk()
    w.event('compact')
    expect(fs.existsSync(path.join(dir, 'logs'))).toBe(false)
  })

  it('suppressed / enabled=false 时 event() 不写', () => {
    let on = true
    const w = mk({ enabled: () => on })
    w.onMessage({ role: 'user', content: 'go' }, 1)
    w.suppressed = true
    w.event('中断')
    w.suppressed = false
    on = false
    w.event('compact')
    const txt = read('go')
    expect(txt).not.toContain('~ 中断')
    expect(txt).not.toContain('~ compact')
  })
})

describe('门控与 fail-safe', () => {
  it('enabled() 为假时不写（/pause-memory）', () => {
    let on = true
    const w = mk({ enabled: () => on })
    w.onMessage({ role: 'user', content: '第一条' }, 1)
    on = false
    w.onMessage({ role: 'user', content: '第二条' }, 2)
    const txt = read('第一条')
    expect(txt).toContain('> 第一条')
    expect(txt).not.toContain('第二条')
  })

  it('suppressed 为真时不写（compact/fork/background 重放）', () => {
    const w = mk()
    w.onMessage({ role: 'user', content: 'go' }, 1)
    w.suppressed = true
    w.onMessage({ role: 'user', content: '重放的历史' }, 2)
    w.suppressed = false
    expect(read('go')).not.toContain('重放的历史')
  })

  it('落盘失败不抛出（memdir 指向不可写路径）', () => {
    const w = createActivityWriter({
      memdir: () => '/proc/nonexistent-deepcode-test',
      sessionId: 's', meta: { cwd: '/r', model: 'm' }, enabled: () => true, now: () => WHEN,
    })
    expect(() => w.onMessage({ role: 'user', content: 'x' }, 1)).not.toThrow()
  })

  it('建文件后目录被删（写失败）不抛出，且 writer 自锁不再重试', () => {
    const w = mk()
    w.onMessage({ role: 'user', content: 'go' }, 1)
    fs.rmSync(dir, { recursive: true, force: true })
    expect(() => w.onMessage({ role: 'user', content: '继续' }, 2)).not.toThrow()
    expect(() => w.event('compact')).not.toThrow()
    expect(fs.existsSync(dir)).toBe(false)   // 不重建目录
  })

  it('非对象消息不抛出', () => {
    const w = mk()
    expect(() => w.onMessage(null as any)).not.toThrow()
    expect(() => w.onMessage('x' as any)).not.toThrow()
  })

  // 回调是宿主传进来的（enabled 读配置、displayText 比对指导语常量…），任一处 TypeError
  // 都会顺着会话的消息落盘路径炸上去。fail-safe 是硬不变量：一条都不许穿透。
  it('宿主回调抛异常不穿透（enabled / displayText / toolOk / isReadOnly / event）', () => {
    const boom = (): any => { throw new TypeError('boom') }
    const user = { role: 'user', content: 'go' }
    const edit = { role: 'assistant', content: null, tool_calls: [
      { id: 't1', function: { name: 'Edit', arguments: '{"file_path":"a.ts"}' } },
    ] }
    const result = { role: 'tool', tool_call_id: 't1', content: '已编辑' }

    expect(() => mk({ enabled: boom }).onMessage(user, 1)).not.toThrow()
    expect(() => mk({ enabled: boom }).event('compact')).not.toThrow()
    expect(() => mk({ displayText: boom }).onMessage(user, 1)).not.toThrow()

    const w1 = mk({ toolOk: boom })
    w1.onMessage(user, 1); w1.onMessage(edit)
    expect(() => w1.onMessage(result)).not.toThrow()

    const w2 = mk({ toolOk: () => true, isReadOnly: boom })
    w2.onMessage(user, 1); w2.onMessage(edit)
    expect(() => w2.onMessage(result)).not.toThrow()
  })

  // 回归：折叠曾是「先 truncate 到行首、再 append 新行」——append 失败（ENOSPC/EIO）
  // 会把那条已经成功落盘的工具行永久抹掉。改成定位覆写后，写失败 = 文件原样不动。
  it('折叠回写失败（ENOSPC）不丢已落盘的行', () => {
    const w = mk({ isReadOnly: () => false, toolOk: () => true })
    const call = (id: string) => {
      w.onMessage({ role: 'assistant', content: null, tool_calls: [
        { id, function: { name: 'Edit', arguments: '{"file_path":"a.ts"}' } },
      ] })
      w.onMessage({ role: 'tool', tool_call_id: id, content: '已编辑' })
    }
    w.onMessage({ role: 'user', content: 'go' }, 1)
    call('t1')
    const before = read('go')
    expect(before).toContain('. Edit(a.ts) ✓')

    const spy = vi.spyOn(fs, 'writeSync').mockImplementation(() => {
      const e: any = new Error('no space left on device'); e.code = 'ENOSPC'; throw e
    })
    try {
      expect(() => call('t2')).not.toThrow()   // 折叠路径：写失败
    } finally { spy.mockRestore() }

    expect(read('go')).toBe(before)            // 文件原样：工具行还在，没被截掉
  })

  // 变异测试守卫：把 intact 判定改成恒真（等于删掉守卫）时，本条必须变红。
  it('文件被外部追加后放弃折叠，不覆写别人的字节（intact 守卫）', () => {
    const w = mk({ isReadOnly: () => false, toolOk: () => true })
    const call = (id: string) => {
      w.onMessage({ role: 'assistant', content: null, tool_calls: [
        { id, function: { name: 'Edit', arguments: '{"file_path":"src/a.ts"}' } },
      ] })
      w.onMessage({ role: 'tool', tool_call_id: id, content: '已编辑' })
    }
    w.onMessage({ role: 'user', content: 'go' }, 1)
    call('t1')
    fs.appendFileSync(logFile('go'), '外部写入\n')   // 别人（另一进程/编辑器）追加
    call('t2')
    call('t3')

    const txt = read('go')
    expect(txt).toContain('外部写入')                              // ① 外部内容仍在
    expect(txt.split('---\n')[2].trim().split('\n')).toEqual([    // ② 没被截掉 ③ 退化为普通追加
      '> go',
      '. Edit(src/a.ts) ✓',
      '外部写入',
      '. Edit(src/a.ts) ✓ ×2',   // 只与外部写入**之后**的新行折叠，不与旧行折叠
    ])
  })
})

describe('pending 簿记', () => {
  it('tool 结果落在门控外时也清 pending（不泄漏、重放不写）', () => {
    let on = true
    const w = mk({ enabled: () => on, isReadOnly: () => false, toolOk: () => true })
    w.onMessage({ role: 'user', content: 'go' }, 1)
    w.onMessage({ role: 'assistant', content: null, tool_calls: [
      { id: 't1', function: { name: 'Write', arguments: '{"file_path":"a.ts","content":"整份文件正文"}' } },
    ] })
    on = false
    w.onMessage({ role: 'tool', tool_call_id: 't1', content: '已写入' })   // 门控外：entry 仍要清
    on = true
    w.onMessage({ role: 'tool', tool_call_id: 't1', content: '已写入' })   // 已清 → 孤儿，不写
    expect(read('go')).not.toContain('. Write')
  })

  it('pending 上限 200，超出丢最老的', () => {
    const w = mk({ isReadOnly: () => false, toolOk: () => true })
    w.onMessage({ role: 'user', content: 'go' }, 1)
    for (let i = 0; i < 250; i++) {
      w.onMessage({ role: 'assistant', content: null, tool_calls: [
        { id: `t${i}`, function: { name: 'Edit', arguments: `{"file_path":"f${i}.ts"}` } },
      ] })
    }
    w.onMessage({ role: 'tool', tool_call_id: 't0', content: '已编辑' })     // 最老的已被丢弃
    w.onMessage({ role: 'tool', tool_call_id: 't249', content: '已编辑' })   // 最新的还在
    const txt = read('go')
    expect(txt).not.toContain('f0.ts')
    expect(txt).toContain('. Edit(f249.ts) ✓')
  })
})

describe('resume：同路径不重复写 frontmatter', () => {
  it('第二个 writer 实例接着追加，不在正文中间再插一份 frontmatter', () => {
    const w1 = mk()
    w1.onMessage({ role: 'user', content: 'go' }, 1)
    const w2 = mk()   // resume：同 sessionId + 同日 + 同首条消息 → 同一路径
    w2.onMessage({ role: 'user', content: 'go' }, 1)

    const txt = read('go')
    expect(txt.match(/^---$/gm)!.length).toBe(2)             // 只有一对 frontmatter 分隔线
    expect(txt.match(/^session: sess-1$/gm)!.length).toBe(1)
    expect(txt.match(/^> go$/gm)!.length).toBe(2)            // 两条用户行都在
  })
})

describe('sessionStartedAt：从 sessionId 反解创建时刻', () => {
  it('正常 sessionId（session.ts:80 的真实形态）→ 还原出对应 UTC 时刻', () => {
    const d = sessionStartedAt('2026-07-13T03-26-29-006Z-2vmb')
    expect(d).not.toBeNull()
    expect(d!.toISOString()).toBe('2026-07-13T03:26:29.006Z')
  })

  it('畸形 sessionId（不匹配格式）→ null', () => {
    expect(sessionStartedAt('sess-1')).toBeNull()
    expect(sessionStartedAt('')).toBeNull()
    expect(sessionStartedAt('not-a-session-id')).toBeNull()
  })

  it('畸形 sessionId（格式对但日期不合法）→ null', () => {
    expect(sessionStartedAt('2026-13-40T99-99-99-999Z-xyz')).toBeNull()
  })
})

describe('修 1：日志目录从 sessionId 解析日期，而非 now()', () => {
  const NOW = new Date(2026, 6, 13, 10, 0, 0)   // 本地时区 2026-07-13（今天 resume）

  it('跨天 resume：sessionId 是昨天的、now() 是今天 → 文件落进 sessionId 的日期目录', () => {
    const sid = '2026-07-12T01-00-00-000Z-abcd'   // 会话真实创建于 07-12
    const w = createActivityWriter({
      memdir: () => dir, sessionId: sid, meta: { cwd: '/repo', model: 'm' },
      enabled: () => true, now: () => NOW,
    })
    w.onMessage({ role: 'user', content: '继续昨天的活' }, 1)

    const expectedPath = path.join(dir, 'logs/2026/07/12', `${sid}-继续昨天的活.md`)
    expect(fs.existsSync(expectedPath)).toBe(true)
    expect(fs.existsSync(path.join(dir, 'logs/2026/07/13'))).toBe(false)   // 没落进 now() 的日期目录
    expect(fs.readFileSync(expectedPath, 'utf8')).toContain('started: 2026-07-12T01:00:00.000Z')
  })

  it('畸形 sessionId 解析不出日期 → 回退 now()', () => {
    const w = createActivityWriter({
      memdir: () => dir, sessionId: 'sess-legacy', meta: { cwd: '/repo', model: 'm' },
      enabled: () => true, now: () => NOW,
    })
    w.onMessage({ role: 'user', content: 'go' }, 1)
    expect(fs.existsSync(path.join(dir, 'logs/2026/07/13', 'sess-legacy-go.md'))).toBe(true)
  })
})

describe('修 2：slug 支持显式传入', () => {
  it('传入 slug 时，文件名用它而不是首条消息推导的 slug', () => {
    const w = mk({ slug: '显式标题' })
    w.onMessage({ role: 'user', content: '这句话不该出现在文件名里' }, 1)
    expect(fs.existsSync(logFile('显式标题'))).toBe(true)
    expect(fs.existsSync(logFile('这句话不该出现在文件名里'))).toBe(false)
    expect(read('显式标题')).toContain('> 这句话不该出现在文件名里')   // 正文内容不受影响，只影响文件名
  })

  it('不传 slug 时行为不变：从首条消息推导', () => {
    const w = mk()
    w.onMessage({ role: 'user', content: '照旧推导' }, 1)
    expect(fs.existsSync(logFile('照旧推导'))).toBe(true)
  })
})

describe('修 3：兜底——同 sessionId 已有日志文件则复用', () => {
  it('预置旧文件（不同日期目录、不同标题）→ 新 writer 复用旧文件，不新建、不重复 frontmatter', () => {
    const sid = '2026-07-12T01-00-00-000Z-fallback'
    // 模拟「修复前」遗留的旧文件：日期目录 07-10 与 sessionId 真实日期（07-12）、
    // 以及 now()（07-13）都不同——证明兜底命中的是「找到已存在文件」而非巧合落在同一路径。
    const oldDir = path.join(dir, 'logs/2026/07/10')
    fs.mkdirSync(oldDir, { recursive: true })
    const oldFile = path.join(oldDir, `${sid}-老标题.md`)
    fs.writeFileSync(oldFile, [
      '---',
      `session: ${sid}`,
      'cwd: /repo',
      'model: m',
      'started: 2026-07-10T01:00:00.000Z',
      '---',
      '',
      '> 老对话',
      '',
    ].join('\n'))

    const NOW = new Date(2026, 6, 13, 10, 0, 0)   // 又一个不同的日期
    const w = createActivityWriter({
      memdir: () => dir, sessionId: sid, meta: { cwd: '/repo', model: 'm' },
      enabled: () => true, now: () => NOW, slug: '新标题',   // 不同 slug，接线方“忘了传”场景的反面也验证：传了也不该新建
    })
    w.onMessage({ role: 'user', content: '新消息' }, 1)

    const txt = fs.readFileSync(oldFile, 'utf8')
    expect(txt).toContain('> 老对话')
    expect(txt).toContain('> 新消息')
    expect(txt.match(/^---$/gm)!.length).toBe(2)   // 没有重复 frontmatter

    // 没有新建任何文件：logs/ 下只有这一个 .md
    const found: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.name.endsWith('.md')) found.push(full)
      }
    }
    walk(path.join(dir, 'logs'))
    expect(found).toEqual([oldFile])
  })

  it('查找失败（logs 目录不存在）按“没找到”处理，正常新建文件，不抛', () => {
    const w = mk()
    expect(() => w.onMessage({ role: 'user', content: 'go' }, 1)).not.toThrow()
    expect(read('go')).toContain('> go')
  })

  // M1 回归：上次 writeFileSync(p, fm, {flag:'a'}) 在 open 成功、write 之前进程被杀，
  // 留下 0 字节残留文件。兜底命中它就直接复用 → frontmatter 永久缺失。0 字节应视为“没找到”。
  it('命中的旧文件是 0 字节残留 → 不复用，走正常新建流程写 frontmatter', () => {
    const sid = '2026-07-12T01-00-00-000Z-zerobyte'
    const oldDir = path.join(dir, 'logs/2026/07/10')
    fs.mkdirSync(oldDir, { recursive: true })
    fs.writeFileSync(path.join(oldDir, `${sid}-老标题.md`), '')   // 0 字节残留

    const w = createActivityWriter({
      memdir: () => dir, sessionId: sid, meta: { cwd: '/repo', model: 'glm-5.2' },
      enabled: () => true, now: () => new Date(2026, 6, 13, 10, 0, 0),
    })
    w.onMessage({ role: 'user', content: '新消息' }, 1)

    const expectedPath = path.join(dir, 'logs/2026/07/12', `${sid}-新消息.md`)
    const txt = fs.readFileSync(expectedPath, 'utf8')
    expect(txt).toContain(`session: ${sid}`)
    expect(txt).toContain('cwd: /repo')
    expect(txt).toContain('model: glm-5.2')
    expect(txt).toContain('started: 2026-07-12T01:00:00.000Z')
    expect(txt).toContain('> 新消息')
  })

  // M2 回归：appendFileSync 在 ENOSPC 下可能部分写入后抛出（writer 随即标 dead），
  // 留下末尾无换行符的半截行。下次 resume 复用该文件，新行绝不能拼到旧行尾。
  it('命中的旧文件末尾没有换行符 → 复用前先补换行，新行不与旧行粘连', () => {
    const sid = '2026-07-12T01-00-00-000Z-nonewline'
    const oldDir = path.join(dir, 'logs/2026/07/10')
    fs.mkdirSync(oldDir, { recursive: true })
    const oldFile = path.join(oldDir, `${sid}-老标题.md`)
    fs.writeFileSync(oldFile, [
      '---',
      `session: ${sid}`,
      'cwd: /repo',
      'model: m',
      'started: 2026-07-10T01:00:00.000Z',
      '---',
      '',
      '> 老对话',   // 注意：没有结尾换行符
    ].join('\n'))

    const w = createActivityWriter({
      memdir: () => dir, sessionId: sid, meta: { cwd: '/repo', model: 'm' },
      enabled: () => true, now: () => new Date(2026, 6, 13, 10, 0, 0),
    })
    w.onMessage({ role: 'user', content: '新的' }, 1)

    const txt = fs.readFileSync(oldFile, 'utf8')
    expect(txt.split('\n')).toContain('> 老对话')
    expect(txt.split('\n')).toContain('> 新的')
    expect(txt).not.toMatch(/老对话.*新的/)
  })
})
