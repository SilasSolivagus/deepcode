// src/tui/components/InputBox.tsx
// 输入框：圆角蓝边框、placeholder、历史↑↓、行尾 \ 续行、Esc 双语义、busy 态提示。
// 不用 ink-text-input：自管 value/cursor，否则历史与续行语义插不进去。
// busy 态：Enter 调 onSteer(text) 排队转向（toolInFlight 时 useChat 内部自动附带软中断）；
// ESC 在队列非空时 onSteerPop 拉回、队列空时 onInterrupt 硬中断。
// 实现细节：状态变更统一走 setVal helper（同步 ref+state+onChange），useInput handler
// 读 ref 而非闭包，避免连续按键（↑↑↓）时读到旧状态。
import React, { useState, useRef, useEffect } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import { useTheme } from '../theme.js'
import {
  normalizePaste, shouldFold, makePlaceholder, countNewlines, truncateBuffer,
  type TextEntry, type Attachment,
} from '../pasteFold.js'
import { readImageFile, readClipboardImage, IMAGE_EXT_RE, readDocFile, PDF_EXT_RE } from '../../clipboardImage.js'
import {
  left as ecLeft, right as ecRight, wordLeft, wordRight, toStart, toEnd, insert as ecInsert, splitAtCursor,
  backspace as ecBackspace, del as ecDel, deleteWordBefore, deleteWordAfter, deleteToStart, deleteToEnd,
} from '../editCursor.js'
import { emptyKillRing, kill, yank, yankPop } from '../killRing.js'

// 粘贴合并去抖窗口（ms）+ 判定为「粘贴块」的最小长度。短去抖对粘贴内容不可感知；
// 单字符打字（无换行、短、且无粘贴在途）走同步直插，不引入延迟。
const PASTE_COALESCE_MS = 40
const PASTE_MIN_LEN = 20

export function InputBox(props: {
  onSubmit: (text: string, attachments?: Attachment[]) => void
  onInterrupt: () => void
  onChange?: (value: string) => void
  /** 补全菜单可见时，↑↓/Tab/Enter 由菜单接管（App 传入） */
  suggestionsActive?: boolean
  history: string[]
  busy: boolean
  /** App 层注入值（补全 pick 后替换整个 draft）。nonce 变化时才实际替换，防止 re-render 重置 */
  valueOverride?: { text: string; nonce: number }
  /** busy 态 steering：统一入口（Enter 时调用；toolInFlight 由 useChat 内部决定是否软中断） */
  onSteer?: (text: string, attachments?: Attachment[]) => void
  /** busy 态 steering：弹出最后一条队列项并回填输入框 */
  onSteerPop?: () => void
  /** 当前 steer 队列长度（决定 ESC busy 语义） */
  steerQueueSize?: number
  /** 当前 steer 队列项（展示排队预览） */
  steerQueueItems?: readonly { value: string; priority?: string }[]
}) {
  const T = useTheme()
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const cursorRef = useRef(cursor)
  const killRingRef = useRef(emptyKillRing())
  const lastWasKillRef = useRef(false)
  const yankRegionRef = useRef<{ start: number; end: number } | null>(null)
  const lastWasYankRef = useRef(false)
  const [pending, setPending] = useState('')        // \ 续行累积
  const [histIdx, setHistIdx] = useState(-1)        // -1 = 不在历史
  const [cursorOn, setCursorOn] = useState(true)    // 反色光标闪烁相位（真光标已隐藏，靠此模拟硬件闪烁）

  // refs 存最新值，让 useInput handler 无论何时调用都读到当前状态
  const valueRef = useRef(value)
  const pendingRef = useRef(pending)
  const histIdxRef = useRef(histIdx)
  // 记录上次处理过的 nonce，只在 nonce 变化时注入；挂载时以当前 nonce 初始化（视为已消费，防止 remount 后老值复活）
  const lastNonceRef = useRef<number | undefined>(props.valueOverride?.nonce)

  const { stdout } = useStdout()
  const attachMap = useRef(new Map<number, Attachment>())
  const nextId = useRef(1)
  // 粘贴合并：终端把大粘贴分多个 stdin data 块送来（ink 的「一次粘贴=单回调」对大粘贴不成立），
  // 逐块各折一个占位符会泄漏原文+生成多个相邻占位符。缓冲粘贴态的块，短去抖后整体折叠一次。
  const pasteBufRef = useRef('')
  const pasteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 编辑入口：value + cursor 同步 ref/state/onChange。所有 editCursor 产出走这里。
  const applyCur = (next: { value: string; cursor: number }) => {
    valueRef.current = next.value
    cursorRef.current = next.cursor
    setValue(next.value)
    setCursor(next.cursor)
    props.onChange?.(next.value)
  }
  // 替换整个 value（历史/override/粘贴/图片/clear/提交后）→ 光标落末尾（末尾恒安全，见 clamp 契约）。
  const setVal = (v: string) => { applyCur({ value: v, cursor: v.length }) }

  // valueOverride 注入：nonce 变化时替换内部 value（补全 pick 触发）
  useEffect(() => {
    if (props.valueOverride && props.valueOverride.nonce !== lastNonceRef.current) {
      lastNonceRef.current = props.valueOverride.nonce
      setVal(props.valueOverride.text)
    }
  }, [props.valueOverride?.nonce])  // eslint-disable-line react-hooks/exhaustive-deps

  // 整 buffer 截断：value 超限时折叠中段为 Truncated 占位符
  const truncatedOnce = useRef(false)
  useEffect(() => {
    if (value === '') { truncatedOnce.current = false; return }
    if (truncatedOnce.current) return
    const r = truncateBuffer(value, nextId.current)
    if (r) { nextId.current++; attachMap.current.set(r.entry.id, r.entry); truncatedOnce.current = true; setVal(r.newText) }
  }, [value])  // eslint-disable-line react-hooks/exhaustive-deps

  // 合并缓冲区一次性折叠（去抖触发或提交前手动 flush）
  const flushPasteBuffer = () => {
    if (pasteTimerRef.current) { clearTimeout(pasteTimerRef.current); pasteTimerRef.current = null }
    const raw = pasteBufRef.current
    pasteBufRef.current = ''
    if (!raw) return
    const clean = normalizePaste(raw)
    if (!clean) return
    const rows = stdout?.rows ?? 24
    if (shouldFold(clean, rows)) {
      const id = nextId.current++
      attachMap.current.set(id, { id, type: 'text', content: clean })
      setVal(valueRef.current + makePlaceholder(id, countNewlines(clean)))
    } else {
      setVal(valueRef.current + clean)
    }
  }
  // 卸载时清掉悬挂的去抖定时器（避免卸载后 setState）
  useEffect(() => () => { if (pasteTimerRef.current) clearTimeout(pasteTimerRef.current) }, [])
  // 光标闪烁：真终端光标已隐藏（见 App/FullscreenApp 移除停泊），用定时翻转反色相位模拟硬件光标闪烁（~530ms 经典 VT 周期）。
  useEffect(() => { const id = setInterval(() => setCursorOn(v => !v), 530); return () => clearInterval(id) }, [])

  useInput((input, key) => {
    // 控制键到来时先处理悬挂的粘贴缓冲：ESC 丢弃，其余键先 flush 把粘贴内容物化进 value
    if (pasteTimerRef.current && (key.return || key.escape || key.backspace || key.delete || key.upArrow || key.downArrow || key.tab)) {
      if (key.escape) { pasteBufRef.current = ''; clearTimeout(pasteTimerRef.current); pasteTimerRef.current = null }
      else flushPasteBuffer()
    }
    // emacs kill/yank 链：本次按键默认打断链；只有 kill/yank 分支在末尾重新置 true。
    // 先读上一次标志供 continuing(kill) / gating(yank-pop) 用，再立即清零，
    // 这样任何未显式续链的按键（移动/历史/打字/粘贴/Enter/Esc）都自动打断链。
    const wasKill = lastWasKillRef.current
    const wasYank = lastWasYankRef.current
    lastWasKillRef.current = false
    lastWasYankRef.current = false
    if (key.escape) {
      if (props.busy) {
        if ((props.steerQueueSize ?? 0) > 0) props.onSteerPop?.()
        else props.onInterrupt()
      } else {
        pendingRef.current = ''
        histIdxRef.current = -1
        setPending('')
        setHistIdx(-1)
        setVal('')
      }
      return
    }
    if (key.leftArrow || key.rightArrow) {
      if (props.suggestionsActive) return
      const c = { value: valueRef.current, cursor: cursorRef.current }
      const word = key.ctrl || key.meta
      if (key.leftArrow) applyCur(word ? wordLeft(c) : ecLeft(c))
      else applyCur(word ? wordRight(c) : ecRight(c))
      return
    }
    if (key.return) {
      if (props.suggestionsActive) return            // 菜单接管 Enter
      // 续行优先（与非 busy 同逻辑）
      if (valueRef.current.endsWith('\\')) {
        const next = pendingRef.current + valueRef.current.slice(0, -1) + '\n'
        pendingRef.current = next
        setPending(next)
        setVal('')
        return
      }
      const full = pendingRef.current + valueRef.current
      if (!full.trim()) return
      const attachments = [...attachMap.current.values()]
      if (props.busy) {
        // busy 态：Enter 统一调 onSteer（toolInFlight 时 useChat 内部附带软中断）
        props.onSteer?.(full, attachments)
      } else {
        props.onSubmit(full, attachments)
      }
      attachMap.current = new Map(); nextId.current = 1
      pendingRef.current = ''
      histIdxRef.current = -1
      setPending('')
      setHistIdx(-1)
      setVal('')
      return
    }
    if (key.upArrow || key.downArrow) {
      if (props.suggestionsActive) return            // 菜单接管 ↑↓
      const h = props.history
      if (!h.length) return
      const cur = histIdxRef.current
      const next = key.upArrow ? Math.min(cur + 1, h.length - 1) : Math.max(cur - 1, -1)
      histIdxRef.current = next
      setHistIdx(next)
      setVal(next === -1 ? '' : h[h.length - 1 - next])
      return
    }
    if (key.backspace || key.delete) {
      const c = { value: valueRef.current, cursor: cursorRef.current }
      if (key.meta || key.ctrl) {                       // Alt/Ctrl+Backspace = 删除前一个词
        const r = deleteWordBefore(c)
        killRingRef.current = kill(killRingRef.current, r.killed, 'prepend', wasKill)
        lastWasKillRef.current = true
        applyCur(r.cur)
      } else {                                          // 物理 Backspace / Ctrl+H → 删前（含占位符整删）
        applyCur(ecBackspace(c))
      }
      return
    }
    if (key.ctrl && input === 'v') {
      const img = readClipboardImage()
      if (img) {
        const id = nextId.current++
        attachMap.current.set(id, { id, type: 'image', ...img, source: 'clipboard' })
        setVal(valueRef.current + `[Image #${id}]`)
      }
      return
    }
    const c0 = { value: valueRef.current, cursor: cursorRef.current }
    if (key.ctrl && !key.meta) {
      switch (input) {
        case 'a': applyCur(toStart(c0)); return
        case 'e': applyCur(toEnd(c0)); return
        case 'b': applyCur(ecLeft(c0)); return
        case 'f': applyCur(ecRight(c0)); return
        case 'p': case 'n': {           // 历史（= ↑↓）
          const h = props.history; if (!h.length) return
          const cur = histIdxRef.current
          const next = input === 'p' ? Math.min(cur + 1, h.length - 1) : Math.max(cur - 1, -1)
          histIdxRef.current = next; setHistIdx(next)
          setVal(next === -1 ? '' : h[h.length - 1 - next]); return
        }
        case 'w': { const r = deleteWordBefore(c0); killRingRef.current = kill(killRingRef.current, r.killed, 'prepend', wasKill); lastWasKillRef.current = true; applyCur(r.cur); return }
        case 'u': { const r = deleteToStart(c0); killRingRef.current = kill(killRingRef.current, r.killed, 'prepend', wasKill); lastWasKillRef.current = true; applyCur(r.cur); return }
        case 'k': { const r = deleteToEnd(c0);   killRingRef.current = kill(killRingRef.current, r.killed, 'append',  wasKill); lastWasKillRef.current = true; applyCur(r.cur); return }
        case 'd': { applyCur(ecDel(c0)); return }  // 前向删；空 value 无操作（ecDel 返原值），不在此退出程序
        case 'y': {
          const { ring, text } = yank(killRingRef.current)
          killRingRef.current = ring
          if (text) {
            const start = cursorRef.current
            applyCur(ecInsert(c0, text))
            yankRegionRef.current = { start, end: start + text.length }
            lastWasYankRef.current = true
          }
          return
        }
      }
    }
    if (key.meta && !key.ctrl) {
      switch (input) {
        case 'b': applyCur(wordLeft(c0)); return
        case 'f': applyCur(wordRight(c0)); return
        case 'd': { applyCur(deleteWordAfter(c0).cur); return }
        case 'y': {
          if (!wasYank || !yankRegionRef.current) return
          const { ring, text } = yankPop(killRingRef.current)
          killRingRef.current = ring
          const reg = yankRegionRef.current
          const v = valueRef.current
          const nv = v.slice(0, reg.start) + text + v.slice(reg.end)
          applyCur({ value: nv, cursor: reg.start + text.length })
          yankRegionRef.current = { start: reg.start, end: reg.start + text.length }
          lastWasYankRef.current = true
          return
        }
      }
    }
    if (key.ctrl || key.meta || key.tab) return      // tab 留给菜单
    if (input) {
      // 图片：拖入的图片文件路径（去引号/转义空格）——单块同步检测，不进缓冲
      const trimmed = input.trim().replace(/^['"]|['"]$/g, '').replace(/\\ /g, ' ')
      if (IMAGE_EXT_RE.test(trimmed)) {
        const img = readImageFile(trimmed)
        if (img) {
          const id = nextId.current++
          attachMap.current.set(id, { id, type: 'image', ...img, source: 'file' })
          setVal(valueRef.current + `[Image #${id}]`)
          return
        }
      }
      if (PDF_EXT_RE.test(trimmed)) {
        const doc = readDocFile(trimmed)
        if (doc) {
          const id = nextId.current++
          attachMap.current.set(id, { id, type: 'doc', ...doc })
          setVal(valueRef.current + `[Doc #${id}]`)
          return
        }
      }
      // 粘贴块（含换行 / 较长 / 已有粘贴在途）→ 缓冲，去抖后整体折叠一次；
      // 单字符打字 → 同步直插，零延迟。
      const pasteLike = pasteTimerRef.current !== null || /[\r\n]/.test(input) || input.length > PASTE_MIN_LEN
      if (pasteLike) {
        pasteBufRef.current += input
        if (pasteTimerRef.current) clearTimeout(pasteTimerRef.current)
        pasteTimerRef.current = setTimeout(flushPasteBuffer, PASTE_COALESCE_MS)
        return
      }
      const clean = normalizePaste(input)
      if (clean) applyCur(ecInsert({ value: valueRef.current, cursor: cursorRef.current }, clean))
    }
  })

  return (
    <Box flexDirection="column">
      {(props.steerQueueItems?.length ?? 0) > 0 && (
        <Box flexDirection="column">
          {props.steerQueueItems!.map((it, i) => (
            <Text key={i} dimColor>
              {'⏵ 排队 '}
              {it.value.length > 60 ? it.value.slice(0, 60) + '…' : it.value}
            </Text>
          ))}
        </Box>
      )}
      {pending !== '' && <Text dimColor>…续行中（{pending.split('\n').length} 行）</Text>}
      <Box borderStyle="round" borderColor={T.accent} borderLeft={false} borderRight={false} paddingX={1}>
        <Text color={T.accent}>{'❯ '}</Text>
        {value === '' && pending === ''
          ? <Text><Text inverse={cursorOn}> </Text><Text dimColor>{props.busy ? '生成中… esc 中断' : '随便问点什么…'}</Text></Text>
          : (() => {
              const s = splitAtCursor(value, cursor)
              return <Text>{s.before}<Text inverse={cursorOn}>{s.at || ' '}</Text>{s.after}</Text>
            })()}
      </Box>
    </Box>
  )
}
