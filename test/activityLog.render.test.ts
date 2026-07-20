import { describe, it, expect } from 'vitest'
import {
  toolArgSummary, renderToolLine, renderUserLines, renderAssistantLine,
  unwrapSteering, slugify, activityLogPath, USER_MAX, ASSISTANT_MAX,
} from '../src/memdir/activityLog.js'

describe('toolArgSummary：per-tool 取值表', () => {
  it('Bash 取 command（上限 120）', () => {
    expect(toolArgSummary('Bash', { command: 'npm test' })).toBe('npm test')
    expect(toolArgSummary('Bash', { command: 'x'.repeat(200) }).length).toBe(121) // 120 + '…'
  })
  it('Edit/Write/Read 取 file_path', () => {
    expect(toolArgSummary('Edit', { file_path: 'src/api.ts', old_string: 'a' })).toBe('src/api.ts')
  })
  it('Grep 取 pattern 而非 path，并附 in <path>', () => {
    expect(toolArgSummary('Grep', { pattern: '风控', path: '/repo' })).toBe('风控 in /repo')
  })
  it('未知工具取第一个 string 参数', () => {
    expect(toolArgSummary('Weird', { n: 1, s: 'hello' })).toBe('hello')
  })
  it('无可用参数返回空串', () => {
    expect(toolArgSummary('Weird', {})).toBe('')
  })
})

describe('renderToolLine', () => {
  it('成功：只有签名与 ✓', () => {
    expect(renderToolLine('Edit', { file_path: 'src/a.ts' }, true, '已编辑')).toBe('. Edit(src/a.ts) ✓')
  })
  it('失败：带错误摘要（截 200，换行折平）', () => {
    const line = renderToolLine('Bash', { command: 'npm test' }, false, '错误：命令超时\n（15000ms）')
    expect(line).toBe('. Bash(npm test) ✗ 错误：命令超时 （15000ms）')
  })
  it('ok 未知（中断合成的 tool 消息）：不画符号，不撒谎', () => {
    expect(renderToolLine('Read', { file_path: 'a.ts' }, undefined, '（中断，无结果）')).toBe('. Read(a.ts)')
  })
})

describe('renderUserLines：不截断、多行多前缀、剥 system-reminder', () => {
  it('剥掉 <system-reminder> 尾巴', () => {
    expect(renderUserLines('干活\n\n<system-reminder>\n提醒\n</system-reminder>')).toEqual(['> 干活'])
  })
  it('多行消息 = 多个 > 行', () => {
    expect(renderUserLines('第一行\n第二行')).toEqual(['> 第一行', '> 第二行'])
  })
  it('短消息不截断（93% 的用户消息不足 200 字符）', () => {
    expect(renderUserLines('嗯')).toEqual(['> 嗯'])
  })
  it('超长才截断（上限 4000）', () => {
    const out = renderUserLines('x'.repeat(5000)).join('\n')
    expect(out).toContain('…[截断]')
    expect(out.length).toBeLessThan(USER_MAX + 20)
  })
})

describe('renderAssistantLine：结论行，截 1200', () => {
  it('换行折平', () => {
    expect(renderAssistantLine('结论：\n共 5 个模块')).toBe('< 结论： 共 5 个模块')
  })
  it('空内容返回 null', () => {
    expect(renderAssistantLine('   ')).toBeNull()
  })
  it('超 1200 截断', () => {
    expect(renderAssistantLine('x'.repeat(2000))!.length).toBe(ASSISTANT_MAX + 3) // '< ' + 1200 + '…'
  })
})

describe('unwrapSteering：steering 是用户真说的话', () => {
  it('拆出内层原文', () => {
    const wrapped = '<queued-user-message>\n用户在你执行过程中补充了这条消息（在你看到它之前已发出）。请据此调整当前工作：\n先跑测试\n</queued-user-message>'
    expect(unwrapSteering(wrapped)).toBe('先跑测试')
  })
  it('非 steering 返回 null', () => {
    expect(unwrapSteering('普通消息')).toBeNull()
  })
})

describe('slugify', () => {
  it('去掉路径分隔符与控制字符，限 40 字符', () => {
    expect(slugify('修 a/b 的 bug')).toBe('修-a-b-的-bug')
    expect(slugify('x'.repeat(80)).length).toBeLessThanOrEqual(40)
  })
  it('空输入回退', () => {
    expect(slugify('   ')).toBe('untitled')
  })
})

describe('activityLogPath', () => {
  it('logs/YYYY/MM/DD/<id>-<slug>.md（本地时区）', () => {
    const p = activityLogPath('/mem', new Date(2026, 6, 13, 10, 30), 'sess-1', 'hello')
    expect(p).toBe('/mem/logs/2026/07/13/sess-1-hello.md')
  })
})
