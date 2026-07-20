// 仅携带 launch-only、不进会话 meta 的 flag：--yolo（安全模型要求每次启动显式给），
// 以及自定义 --settings 路径（子进程需读同一分层配置，否则可能落回默认 provider/config）。
// model/permMode/add-dir 不带：带 --resume 时 model/acceptEdits 由 resume-meta 恢复
// （useChat.restoreSession），add-dir 是运行时态（与普通重启一致）；交互路径也不消费它们。
export function buildCarryFlags(state: { yolo: boolean; settingsPath?: string }): string[] {
  const a: string[] = []
  if (state.yolo) a.push('--yolo')
  if (state.settingsPath) a.push('--settings', state.settingsPath)
  return a
}

export function buildResumeArgs(opts: { sessionFile?: string; hasTranscript: boolean }): string[] {
  if (opts.sessionFile && opts.hasTranscript) return ['--resume', opts.sessionFile]
  return []
}

export function buildSwitchEnv(target: 'inline' | 'fullscreen', base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, DEEPCODE_TUI_JUST_SWITCHED: target }
  delete env.DEEPCODE_INLINE
  return env
}

export function guardSwitch(ctx: { bg: boolean; anyRunningWork: boolean }): { ok: true } | { ok: false; message: string } {
  if (ctx.bg) return { ok: false, message: '后台会话固定使用全屏渲染器。' }
  if (ctx.anyRunningWork) return { ok: false, message: '有后台工作正在运行，无法切换渲染器——等它结束（或用 /fleet 停止），再运行 /tui。' }
  return { ok: true }
}

export interface PerformSwitchDeps {
  target: 'inline' | 'fullscreen'
  guardCtx: { bg: boolean; anyRunningWork: boolean }
  state: { yolo: boolean; settingsPath?: string }
  resume: { sessionFile?: string; hasTranscript: boolean }
  entryScript: string
  execPath: string
  baseEnv: NodeJS.ProcessEnv
  saveSettings: (patch: { tui: 'inline' | 'fullscreen' }) => { error: Error | null }
  unmount: () => void
  spawnSync: (cmd: string, args: string[], opts: any) => { status: number | null; error?: Error }
  exit: (code: number) => void
  onError?: (msg: string) => void
}

export function performTuiSwitch(deps: PerformSwitchDeps): void {
  const g = guardSwitch(deps.guardCtx)
  if (!g.ok) { deps.onError?.(g.message); return }
  const { error } = deps.saveSettings({ tui: deps.target })
  if (error) { deps.onError?.(`保存设置失败：${error.message}`); return }
  const args = [
    ...buildResumeArgs(deps.resume),
    ...buildCarryFlags(deps.state),
  ]
  const env = buildSwitchEnv(deps.target, deps.baseEnv)
  // unmount 之后 ink 树已卸载，onError → notice 用户根本看不见；且不退出会留下「UI 已死、进程还挂着」的僵尸。
  // 故 unmount 之后的失败一律写 stderr + 非零退出。
  try {
    deps.unmount()
    const child = deps.spawnSync(deps.execPath, [deps.entryScript, ...args], { stdio: 'inherit', env })
    if (child.error) {
      console.error(`[deepcode] 无法切换渲染器——${child.error.message}。设置已保存，重启 deepcode 生效。`)
      deps.exit(1)
      return
    }
    deps.exit(child.status ?? 1) // status===null = 被信号杀死，不能谎报成功
  } catch (e: any) {
    console.error(`[deepcode] 无法切换渲染器——${e?.message ?? e}。设置已保存，重启 deepcode 生效。`)
    deps.exit(1)
  }
}
