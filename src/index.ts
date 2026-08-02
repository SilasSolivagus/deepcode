#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Silas <dirctable@gmail.com>
// deepcode — https://github.com/SilasSolivagus/deepcode
// src/index.ts
import { createClient } from './api.js'
import { hasApiKey } from './config.js'
import { setFlagSettingsPath } from './settingsLayers.js'
import { parseOutputFormat, parseMaxTurns } from './streamJson.js'
import { resolveTraceDir } from './requestTrace.js'

const argv = process.argv
const yolo = argv.includes('--yolo')
const continueSession = argv.includes('--continue') || argv.includes('-c')
const inlineFlag = argv.includes('--inline') || process.env.DEEPCODE_INLINE === '1'
const pIdx = argv.indexOf('-p')
const settingsFlagIdx = argv.indexOf('--settings')
const flagSettingsPath = settingsFlagIdx >= 0 ? argv[settingsFlagIdx + 1] : undefined
// 进程级登记：令运行期 arg-less loadSettings()（activeProvider/计价/权限归属等）也认 --settings，
// 否则 client 用 flag settings、而这些读真实 settings，二者割裂（provider/计价错位）。须在任何 loadSettings 之前。
setFlagSettingsPath(flagSettingsPath)
const bgRun = argv.includes('--background-run')
const resumeIdx = argv.indexOf('--resume')
const resumeFile = resumeIdx >= 0 ? argv[resumeIdx + 1] : undefined
const jobIdx = argv.indexOf('--job')
const jobShort = jobIdx >= 0 ? argv[jobIdx + 1] : undefined
const permIdx = argv.indexOf('--permission-mode')
const permMode = permIdx >= 0 ? argv[permIdx + 1] : undefined
const modelIdx = argv.indexOf('--model')
const modelFlag = modelIdx >= 0 ? argv[modelIdx + 1] : undefined
// headless/piped 路径无法像交互式那样跑首跑向导，报错须直接告诉用户怎么办。
const NO_KEY_MSG = '未配置任何模型 API key。请直接运行 `deepcode`（交互式）完成首次配置，或设置环境变量 DEEPSEEK_API_KEY / ZHIPUAI_API_KEY / MOONSHOT_API_KEY。'

try {
  // 提到分支之外：非法取值（如 --trace 缺值）在任何入口都当场抛错，而不是只在 -p 分支才校验。
  const traceDir = resolveTraceDir(argv, process.env)
  if (bgRun) {
    if (!resumeFile || !jobShort) throw new Error('--background-run 需 --resume <file> 与 --job <short>')
    const client = createClient(flagSettingsPath)
    const { runBackgroundSession } = await import('./backgroundRunner.js')
    // seed = -p 之后的值（父进程用 -p 传 seed）；无 -p 则续跑未完回合
    const seed = pIdx !== -1 ? argv[pIdx + 1] : undefined
    // 注：--background-run 子进程当前不支持请求侧轨迹——它由 TUI 的 /background 经
    // buildBackgroundArgv 拼出 argv 拉起，TUI 本身不接 traceDir（见下方 else 分支），
    // 故这里从未真正拿到过有效的 traceDir 可透传。见 README「用法 & 命令」的说明。
    await runBackgroundSession({ client, resumeFile, jobShort, seed, yolo, permMode, model: modelFlag, flagSettingsPath })
    process.exit(0)
  } else if (pIdx !== -1) {
    const prompt = argv[pIdx + 1]
    if (!prompt || prompt.startsWith('-')) throw new Error('用法：deepcode -p "<任务>" [--output-format text|json|stream-json] [--trace <dir>] [--max-turns <n>] [--yolo]')
    if (!hasApiKey()) throw new Error(NO_KEY_MSG)
    const client = createClient(flagSettingsPath)
    const outputFormat = parseOutputFormat(argv)
    const maxTurns = parseMaxTurns(argv)
    const { runHeadless } = await import('./headless.js')
    const r = await runHeadless({ client, prompt, yolo, flagSettingsPath, outputFormat, traceDir, maxTurns })
    if (outputFormat === 'json') {
      console.log(JSON.stringify({ text: r.text, status: r.status, turns: r.turns, usage: r.usage, costCNY: r.costCNY }))
    } else if (outputFormat === 'text') {
      console.log(r.text)
    }
    // stream-json：runHeadless 已把包括 result 在内的所有事件写到 stdout，这里不再重复输出
    process.exitCode = r.status === 'done' ? 0 : 1
  } else if (!process.stdin.isTTY) {
    // 管道喂入无 -p：读 stdin 全文当 prompt 走 headless
    const chunks: Buffer[] = []
    for await (const c of process.stdin) chunks.push(c)
    const prompt = Buffer.concat(chunks).toString('utf8').trim()
    if (!prompt) throw new Error('stdin 为空。交互模式请直接运行 deepcode，或用 -p "<任务>"')
    if (!hasApiKey()) throw new Error(NO_KEY_MSG)
    const client = createClient(flagSettingsPath)
    const { runHeadless } = await import('./headless.js')
    const r = await runHeadless({ client, prompt, yolo, flagSettingsPath, traceDir })
    console.log(r.text)
    process.exitCode = r.status === 'done' ? 0 : 1
  } else {
    // TTY 交互：TUI 不接请求侧轨迹，给了也不能静默吞掉。
    if (traceDir) process.stderr.write(`⚠ --trace/DEEPCODE_TRACE_DIR 在交互式 TUI 下不生效（仅 -p 与管道 headless 入口支持）：${traceDir}\n`)
    // 无 key 先走首跑向导，再创建 client
    if (!hasApiKey()) {
      const { runSetup } = await import('./tui/setup.js')
      await runSetup()
    }
    const client = createClient(flagSettingsPath)
    const { startTui } = await import('./tui/index.js')
    // Task6：--resume <文件> 交互路径也生效（此前仅 --background-run）；DEEPCODE_TUI_JUST_SWITCHED 读后即清。
    const resumeFileArg = resumeIdx >= 0 && !bgRun ? resumeFile : undefined
    const justSwitched = process.env.DEEPCODE_TUI_JUST_SWITCHED
    if (justSwitched) delete process.env.DEEPCODE_TUI_JUST_SWITCHED
    await startTui({ client, yolo, continueSession, inlineFlag, resumeFile: resumeFileArg, justSwitched, flagSettingsPath })
    process.exit(0) // ink 卸载后 stdin raw 监听可能残留；显式退出兜底
  }
} catch (e: any) {
  console.error(e?.message ?? e)
  process.exitCode = 1
}
