// src/tui/setup.tsx
// 首跑向导：无 API key 时（仅 TTY）在 startTui 之前独立 render，多步收集 key 写 settings.json。
// 独立于 App，因为 createClient 需要 key 才能构造——向导跑在 client 创建之前。
// 状态机：provider（选 DeepSeek/GLM/Kimi/自定义，自定义追加 baseURL/fast/smart）
//        → llmKey（必填，验证失败可 r 重录 / s 仍然保存）
//        → search（可选，Bocha/Tavily 各录各验）
//        → vision（可选；provider===glm 时复用 llmKey 自动跳过）→ done（写盘 + 汇总）。
import React, { useRef, useState } from 'react'
import { render, Box, Text, useInput } from 'ink'
import { saveOnboardingKeys, type OnboardingKeys } from '../config.js'
import { validateLlmKey, validateSearchKey, validateVisionKey, type ValidateResult } from '../keyValidate.js'
import { BUILTIN_PROVIDERS, providerLabel, type ProviderId } from '../providers.js'
import { SelectList } from './components/SelectList.js'
import { DEFAULT_THEME } from './theme.js'
const T = DEFAULT_THEME

const PROVIDER_ORDER: ProviderId[] = ['deepseek', 'glm', 'kimi', 'custom']
const PROVIDER_ITEMS = ['DeepSeek（默认）', 'GLM', 'Kimi', '自定义']

type Step =
  | 'provider'
  | 'customBaseURL' | 'customFast' | 'customSmart'
  | 'llmKey'
  | 'search-bocha' | 'search-tavily'
  | 'vision'
  | 'done'

type Acc = {
  provider: ProviderId
  customBaseURL?: string
  customFast?: string
  customSmart?: string
  llmKey?: string
  bocha?: string
  tavily?: string
  visionKey?: string
}

/** 该 provider 用于验证/落盘的 baseURL + smart 模型（custom 取向导里刚录的值）。 */
function presetFor(a: Acc): { baseURL: string; model: string } {
  if (a.provider === 'custom') return { baseURL: a.customBaseURL ?? '', model: a.customSmart ?? '' }
  const p = BUILTIN_PROVIDERS[a.provider]
  return { baseURL: p.baseURL, model: p.models.smart }
}

/** 无校验的纯文本输入（自定义 provider 的 baseURL/fast/smart 三项）。 */
function TextInputStep(props: { title: string; hint: string; onSubmit: (v: string) => void }) {
  const [val, setVal] = useState('')
  const ref = useRef('')
  const set = (v: string) => { ref.current = v; setVal(v) }
  useInput((input, key) => {
    if (key.return) {
      const v = ref.current.trim()
      if (!v) return
      props.onSubmit(v)
      return
    }
    if (key.backspace || key.delete) { set(ref.current.slice(0, -1)); return }
    if (key.ctrl || key.meta || key.tab) return
    if (input) set(ref.current + input)
  })
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={T.accent} bold>{props.title}</Text>
      <Text dimColor>{props.hint}</Text>
      <Box borderStyle="round" borderColor={T.accent} borderLeft={false} borderRight={false} paddingX={1}>
        <Text color={T.accent}>{'❯ '}</Text>
        <Text>{val}<Text inverse> </Text></Text>
      </Box>
    </Box>
  )
}

/** 遮罩 key 输入 + 当场验证。optional=true 时空回车 = 跳过（onDone(undefined)）。
 *  验证失败展示 error + "r 重录 / s 仍然保存并继续"。 */
function KeyInputStep(props: {
  title: string
  hint: string
  optional: boolean
  validate: (key: string) => Promise<ValidateResult>
  onDone: (key: string | undefined) => void
}) {
  const [val, setVal] = useState('')
  const [phase, setPhase] = useState<'input' | 'validating' | 'error'>('input')
  const [error, setError] = useState('')
  const ref = useRef('')
  const set = (v: string) => { ref.current = v; setVal(v) }

  useInput((input, key) => {
    if (phase === 'validating') return
    if (phase === 'error') {
      const k = input.toLowerCase()
      if (k === 'r') { setPhase('input'); setError(''); set(''); return }
      if (k === 's') { props.onDone(ref.current.trim() || undefined); return }
      return
    }
    if (key.return) {
      const k = ref.current.trim()
      if (!k) {
        if (props.optional) props.onDone(undefined)
        return // 必填步：空回车忽略
      }
      setPhase('validating')
      props.validate(k).then(r => {
        if (r.ok) props.onDone(k)
        else { setError(r.error); setPhase('error') }
      })
      return
    }
    if (key.backspace || key.delete) { set(ref.current.slice(0, -1)); return }
    if (key.ctrl || key.meta || key.tab) return
    if (input) set(ref.current + input)
  })

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={T.accent} bold>{props.title}</Text>
      <Text dimColor>{props.hint}</Text>
      <Box borderStyle="round" borderColor={T.accent} borderLeft={false} borderRight={false} paddingX={1}>
        <Text color={T.accent}>{'❯ '}</Text>
        <Text>{'•'.repeat(val.length)}<Text inverse> </Text></Text>
      </Box>
      {phase === 'validating' && <Text color={T.warn}>验证中…</Text>}
      {phase === 'error' && (
        <Box flexDirection="column">
          <Text color={T.err}>✗ {error}</Text>
          <Text dimColor>r 重录 · s 仍然保存并继续</Text>
        </Box>
      )}
      {phase === 'input' && <Text dimColor>{props.optional ? 'Enter 留空跳过 · Ctrl+C 取消' : 'Enter 确认 · Ctrl+C 取消'}</Text>}
    </Box>
  )
}

export function Setup(props: { onDone: () => void; onCancel?: () => void; initial?: Partial<OnboardingKeys> }) {
  const [step, setStep] = useState<Step>('provider')
  const [summary, setSummary] = useState<string[]>([])
  const acc = useRef<Acc>({
    provider: props.initial?.provider ?? 'deepseek',
    customBaseURL: props.initial?.custom?.baseURL,
    customFast: props.initial?.custom?.models?.fast,
    customSmart: props.initial?.custom?.models?.smart,
  })

  const afterSearch = () => {
    // GLM 复用 LLM key 当 vision key，跳过 vision 步。
    if (acc.current.provider === 'glm') { finish(); return }
    setStep('vision')
  }

  const finish = () => {
    const a = acc.current
    const preset = presetFor(a)
    const keys: OnboardingKeys = {
      provider: a.provider,
      model: preset.model,
      providerKeys: a.llmKey ? { [a.provider]: a.llmKey } : undefined,
      custom: a.provider === 'custom' ? { baseURL: a.customBaseURL!, models: { fast: a.customFast!, smart: a.customSmart! } } : undefined,
      search: (a.bocha || a.tavily) ? { bocha: a.bocha, tavily: a.tavily } : undefined,
      visionGlmKey: a.provider === 'glm' ? a.llmKey : a.visionKey,
    }
    saveOnboardingKeys(keys)

    const searchNote = a.bocha || a.tavily
      ? `✓ 已配 搜索（${[a.bocha ? 'Bocha' : null, a.tavily ? 'Tavily' : null].filter(Boolean).join('/')}）`
      : '· 未配 搜索（以后 /setup 可加）'
    const visionNote = keys.visionGlmKey
      ? `✓ 已配 图片识别${a.provider === 'glm' ? '（复用 LLM key）' : ''}`
      : '· 未配 图片识别（以后 /setup 可加）'
    setSummary([
      `✓ 已配 LLM(${providerLabel(a.provider)})`,
      searchNote,
      visionNote,
    ])
    setStep('done')
  }

  if (step === 'done') return <DoneStep summary={summary} onAny={() => { props.onDone() }} />

  switch (step) {
    case 'provider':
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color={T.accent} bold>🐳 欢迎使用 deepcode</Text>
          <Text> </Text>
          <Text>首次使用，先选 LLM provider：</Text>
          <SelectList
            items={PROVIDER_ITEMS}
            onPick={(idx) => {
              const id = PROVIDER_ORDER[idx]
              acc.current.provider = id
              setStep(id === 'custom' ? 'customBaseURL' : 'llmKey')
            }}
            onCancel={() => props.onCancel?.()}
          />
        </Box>
      )
    case 'customBaseURL':
      return (
        <TextInputStep
          key={step}
          title="自定义 provider · baseURL"
          hint="OpenAI 兼容 API 地址，例如 https://api.example.com/v1"
          onSubmit={(v) => { acc.current.customBaseURL = v; setStep('customFast') }}
        />
      )
    case 'customFast':
      return (
        <TextInputStep
          key={step}
          title="自定义 provider · fast 模型 id"
          hint="日常快档模型 id"
          onSubmit={(v) => { acc.current.customFast = v; setStep('customSmart') }}
        />
      )
    case 'customSmart':
      return (
        <TextInputStep
          key={step}
          title="自定义 provider · smart 模型 id"
          hint="重活/编码模型 id"
          onSubmit={(v) => { acc.current.customSmart = v; setStep('llmKey') }}
        />
      )
    case 'llmKey': {
      const preset = presetFor(acc.current)
      return (
        <KeyInputStep
          key={step}
          title={`${providerLabel(acc.current.provider)} API key`}
          hint="粘贴 key，回车验证"
          optional={false}
          validate={(k) => validateLlmKey({ apiKeyEnvOrKey: k, baseURL: preset.baseURL, model: preset.model })}
          onDone={(k) => { acc.current.llmKey = k; setStep('search-bocha') }}
        />
      )
    }
    case 'search-bocha':
      return (
        <KeyInputStep
          key={step}
          title="搜索 · Bocha（可选）"
          hint="open.bochaai.com 申请 key；Enter 留空跳过"
          optional
          validate={(k) => validateSearchKey('bocha', k)}
          onDone={(k) => { if (k) acc.current.bocha = k; setStep('search-tavily') }}
        />
      )
    case 'search-tavily':
      return (
        <KeyInputStep
          key={step}
          title="搜索 · Tavily（可选）"
          hint="tavily.com 申请 key；Enter 留空跳过"
          optional
          validate={(k) => validateSearchKey('tavily', k)}
          onDone={(k) => { if (k) acc.current.tavily = k; afterSearch() }}
        />
      )
    case 'vision':
      return (
        <KeyInputStep
          key={step}
          title="图片识别（可选）"
          hint="图片识别用 GLM，需智谱 ZHIPUAI_API_KEY（open.bigmodel.cn）；Enter 留空跳过"
          optional
          validate={(k) => validateVisionKey(k)}
          onDone={(k) => { if (k) acc.current.visionKey = k; finish() }}
        />
      )
  }
}

function DoneStep(props: { summary: string[]; onAny: () => void }) {
  useInput(() => { props.onAny() })
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={T.ok} bold>✓ 配置完成</Text>
      {props.summary.map((line, i) => <Text key={i}>{line}</Text>)}
      <Text dimColor>按任意键继续</Text>
    </Box>
  )
}

export async function runSetup(): Promise<void> {
  let inst: { unmount: () => void; waitUntilExit: () => Promise<void> }
  inst = render(<Setup onDone={() => inst.unmount()} onCancel={() => inst.unmount()} />, { exitOnCtrlC: true }) as any
  await inst.waitUntilExit()
}
