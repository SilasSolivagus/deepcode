// src/tui/exitFlush.ts
// 退出前先 flush 记忆再退出的公共 helper：App.tsx / FullscreenApp.tsx 各两处退出路径
// （/exit + Ctrl+C 两次）共用，避免四处内联重复、且让「退出前 await flush」这条
// 不丢数据的关键不变量可被单测直接变异验证。

/**
 * 退出前先 flush 记忆再退出：notify（可选提示）→ await flush（有界，flushMemory 内部保证）→ exit。
 * 顺序不可颠倒——flush 必须在 exit 之前完成，否则进程退出会杀掉还没写完的提取子代理。
 */
export async function flushThenExit(flush: () => Promise<void>, exit: () => void, notify?: () => void): Promise<void> {
  notify?.()
  await flush()
  exit()
}
