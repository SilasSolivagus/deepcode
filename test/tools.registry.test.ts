import { describe, it, expect } from 'vitest'
import { allTools, toApiTools } from '../src/tools/index.js'
import { readTool } from '../src/tools/read.js'
import * as taskTools from '../src/tools/taskTools.js'

describe('registry', () => {
  it('注册了二十个工具（含 ExitPlanMode、EnterWorktree、ExitWorktree、Sleep、ScheduleWakeup、CronCreate、CronList、CronDelete、Monitor、TaskStop、PushNotification、SearchMemory）', () => {
    expect(allTools.map(t => t.name).sort()).toEqual(['Bash', 'Config', 'CronCreate', 'CronDelete', 'CronList', 'Edit', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree', 'Glob', 'Grep', 'Monitor', 'NotebookEdit', 'PushNotification', 'Read', 'ScheduleWakeup', 'SearchMemory', 'Sleep', 'TaskStop', 'Write'])
  })

  it('B2：allTools 只含一个 TaskStop（去重）', () => {
    expect(allTools.filter(t => t.name === 'TaskStop')).toHaveLength(1)
  })

  it('B2：taskTools.ts 不再导出 TaskStop 工具（避免同名重复进 API 列表）', () => {
    const dup = Object.values(taskTools).filter((v: any) => v && typeof v === 'object' && v.name === 'TaskStop')
    expect(dup).toHaveLength(0)
  })

  it('toApiTools 生成 OpenAI function 定义', () => {
    const api = toApiTools([readTool])
    expect(api[0].type).toBe('function')
    expect(api[0].function.name).toBe('Read')
    const params: any = api[0].function.parameters
    expect(params.type).toBe('object')
    expect(params.properties.file_path).toBeDefined()
    expect(params.required).toContain('file_path')
  })
})
