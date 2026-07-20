import type { Settings } from '../config.js'

export function resolveRenderer(opts: {
  bg: boolean
  isTTY: boolean
  inlineFlag: boolean
  settings: Pick<Settings, 'tui' | 'inline'>
}): 'inline' | 'fullscreen' | 'headless' {
  if (opts.bg) return 'fullscreen'
  if (!opts.isTTY) return 'headless'
  if (opts.inlineFlag) return 'inline'
  if (opts.settings.tui) return opts.settings.tui
  if (opts.settings.inline === true) return 'inline'
  return 'fullscreen'
}

export function resolveInitialFocus(
  settings: Pick<Settings, 'viewMode'>,
): { focusMode: boolean; locked: boolean } {
  const locked = settings.viewMode === 'focus'
  return { focusMode: locked, locked }
}
