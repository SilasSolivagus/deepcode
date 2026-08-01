// 请求侧轨迹：把真正发给模型的东西原样落盘。
// 设计见 docs/superpowers/specs/2026-08-01-deepcode-request-trace-design.md
//
// 主捕获点在 chatStream 内：它是五个正常调用方（turn/compact/recap/goal/hook）的共用通道，
// wire payload 就在其内部组装，挂钩于此能捕获真正上线的字节。
//
// chatStream 之外另有直连 client.chat.completions.create 的调用点。B-1 交付时它们全部未接，
// 后续补齐了其中有诊断价值的三处，各自在调用点内联调用 recordRequest：
//   - autoMode.ts               label: classify      auto 模式权限分类器（deepcode 自撰系统提示词 + 兄弟工具输出，最典型的目标内容）
//   - services/memory/signalGate.ts       label: memorySignal  记忆信号门控
//   - services/memory/indexConsolidate.ts label: memoryIndex   记忆索引整合
//
// 刻意不记的两处（判断而非遗漏）：
//   - imageDescribe.ts：发出去的是图片，不是「deepcode 自己说的话」，不属本功能的目标内容
//   - keyValidate.ts：探活 ping，内容零诊断价值，且带 key 校验语义，落盘反而多一份敏感面
//
// 所以准确的说法是：**本功能覆盖「所有有诊断价值的出站请求」，而不是「进程发出的全部请求」。**
// 每个接入点都须守同一条不变式：请求体只拼一次，同一个对象既落盘又发送。

import fs from 'node:fs'
import path from 'node:path'

export interface TraceRecord {
  seq: number
  ts: string
  label: string
  model: string
  messages: any[]
  tools: any[]
  params: Record<string, unknown>
}

/** 组装一条轨迹记录。纯函数：不碰磁盘、不读全局，好让 chatStream 之外能精确断言。 */
export function buildTraceRecord(input: {
  seq: number
  ts: string
  label?: string
  model: string
  wireMessages: any[]
  tools: any[]
  params: Record<string, unknown>
}): TraceRecord {
  return {
    seq: input.seq,
    ts: input.ts,
    label: input.label ?? 'unknown',
    model: input.model,
    messages: input.wireMessages,
    tools: input.tools,
    params: input.params,
  }
}

const FILE_RE = /^req-(\d{4,})\.json$/

/** 诊断功能绝不能让主流程失败：stderr 本身可能不可用（已关闭/EPIPE），写失败就静默吞掉。 */
function safeWarn(msg: string): void {
  try { process.stderr.write(msg) } catch { /* stderr 不可用时静默 */ }
}

/** 扫已有轨迹取下一个编号。目录已存在且非空时续号，避免覆盖上一次跑的轨迹。 */
export function nextSeq(dir: string): number {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 1 // 目录不存在＝首次
  }
  let max = 0
  for (const n of names) {
    const m = FILE_RE.exec(n)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

/** 目录是否「只属于轨迹」：不存在、为空，或只含 req-*.json。只有这种目录才能安全收紧权限——
 *  用户拿一个已有目录（如仓库根）当 --trace 参数时，绝不能把它当成我们建的目录去 chmod。 */
function isTraceOwnedDir(dir: string): boolean {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return true // 不存在＝即将由本次调用创建，视为我们的目录
  }
  return names.every(n => FILE_RE.test(n))
}

/** 落盘一条记录。任何失败都只警告不抛出——诊断功能绝不能让主流程失败。 */
export function writeTraceRecord(dir: string, rec: TraceRecord): boolean {
  try {
    const owned = isTraceOwnedDir(dir) // 须在 mkdirSync 之前判断：那之后目录必然「存在」
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const mode = fs.statSync(dir).mode & 0o777
    if (mode & 0o077) {
      if (owned) {
        fs.chmodSync(dir, 0o700)
        safeWarn(`⚠ 轨迹目录权限过宽（${mode.toString(8)}），已收紧为 0700：${dir}\n`)
      } else {
        // 用户随手指的既有目录（如 --trace .）：只警告，不动它的权限。
        safeWarn(`⚠ 轨迹目录含其它文件，未改动其权限（当前 ${mode.toString(8)}）：${dir}\n` +
          '  轨迹含敏感内容，请自行确认该目录不可被他人读取。\n')
      }
    }
    const file = path.join(dir, `req-${String(rec.seq).padStart(5, '0')}.json`)
    fs.writeFileSync(file, JSON.stringify(rec, null, 2), { mode: 0o600 })
    return true
  } catch (e) {
    safeWarn(`⚠ 请求轨迹落盘失败（已跳过该条）：${(e as Error).message}\n`)
    return false
  }
}

let traceDir: string | undefined
let seq = 1

/** 解析 `--trace <dir>`。非法值抛错而非静默不记录：诊断参数写错却什么都没录，事后无从分辨。 */
export function parseTraceDir(argv: string[]): string | undefined {
  const i = argv.indexOf('--trace')
  if (i < 0) return undefined
  const v = argv[i + 1]
  if (v === undefined || v.length === 0 || v.startsWith('-')) throw new Error('--trace 需要一个目录路径')
  return v
}

/** 开关优先级：显式命令行 > 环境变量 > 不开启。 */
export function resolveTraceDir(argv: string[], env: NodeJS.ProcessEnv): string | undefined {
  return parseTraceDir(argv) ?? env.DEEPCODE_TRACE_DIR ?? undefined
}

export function enableTrace(dir: string): void {
  traceDir = dir
  seq = nextSeq(dir)
  safeWarn(
    `⚠ 请求轨迹已开启：${dir}\n` +
    '  落盘内容含发给模型的完整上下文（可能包含密钥与私有代码），仅供本地诊断，勿外传。\n',
  )
}

export function disableTrace(): void {
  traceDir = undefined
  seq = 1
}

export function traceEnabled(): boolean {
  return traceDir !== undefined
}

/** 记一次请求。未开启时零开销直接返回。 */
export function recordRequest(input: {
  label?: string
  model: string
  wireMessages: any[]
  tools: any[]
  params: Record<string, unknown>
}): void {
  if (traceDir === undefined) return
  const rec = buildTraceRecord({ ...input, seq, ts: new Date().toISOString() })
  writeTraceRecord(traceDir, rec)
  seq++ // 落盘失败也递增：编号连续性服务于「和轮次对齐」，跳号比错号好诊断
}
