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
import { MaskedInput } from './components/MaskedInput.js'
import { DEFAULT_THEME } from './theme.js'
const T = DEFAULT_THEME

const PROVIDER_ORDER: ProviderId[] = ['deepseek', 'glm', 'kimi', 'custom']
const PROVIDER_ITEMS = ['DeepSeek（默认）', 'GLM', 'Kimi', '自定义']

const STEP_LABELS = ['选择模型', '密钥', '搜索', '图片']

/** 圆角 accent 面板外壳：各步内容套进去。title 缺省为向导标题；step 给时在标题下渲染步骤条。 */
function WizardPanel(props: { title?: string; step?: 1 | 2 | 3 | 4; children: React.ReactNode }) {
  return (
    <Box borderStyle="round" borderColor={T.accent} paddingX={1} flexDirection="column">
      <Text color={T.accent} bold>{props.title ?? '✦ deepcode · 首次配置'}</Text>
      {props.step != null && <StepBar current={props.step} />}
      <Text> </Text>
      {props.children}
    </Box>
  )
}

/** 4 步进度条，单行 <Text> 拼接（防 flex row 错乱，镜像 Banner.tsx 做法）。
 *  当前步 accent 高亮，已过步 ✓ 打勾，未到步 ○ 暗色。 */
function StepBar(props: { current: 1 | 2 | 3 | 4 }) {
  return (
    <Text>
      {STEP_LABELS.map((label, i) => {
        const n = (i + 1) as 1 | 2 | 3 | 4
        const isCurrent = n === props.current
        const isDone = n < props.current
        const mark = isDone ? '✓' : isCurrent ? '●' : '○'
        const sep = i < STEP_LABELS.length - 1 ? '  ' : ''
        return (
          <Text key={label} color={isCurrent ? T.accent : undefined} dimColor={!isCurrent} bold={isCurrent}>
            {mark} {label}{sep}
          </Text>
        )
      })}
    </Text>
  )
}

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
  return (
    <>
      <Text color={T.accent} bold>{props.title}</Text>
      <Text dimColor>{props.hint}</Text>
      <Box borderStyle="round" borderColor={T.accent} borderLeft={false} borderRight={false} paddingX={1}>
        <Text color={T.accent}>{'❯ '}</Text>
        <MaskedInput masked={false} onSubmit={(v) => { if (v) props.onSubmit(v) }} />
      </Box>
    </>
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
  const [phase, setPhase] = useState<'input' | 'validating' | 'error'>('input')
  const [error, setError] = useState('')
  const lastRef = useRef('') // error 阶段 's 仍然保存' 用：记住上次提交的值

  const handleSubmit = (v: string) => {
    lastRef.current = v
    if (!v) {
      if (props.optional) props.onDone(undefined)
      return // 必填步：空回车忽略
    }
    setPhase('validating')
    props.validate(v).then(r => {
      if (r.ok) props.onDone(v)
      else { setError(r.error); setPhase('error') }
    })
  }

  // 仅 error 阶段监听 r/s 单键；input 阶段的按键交给下方 MaskedInput 处理。
  useInput((input) => {
    const k = input.toLowerCase()
    if (k === 'r') { setPhase('input'); setError('') }
    else if (k === 's') { props.onDone(lastRef.current || undefined) }
  }, { isActive: phase === 'error' })

  return (
    <>
      <Text color={T.accent} bold>{props.title}</Text>
      <Text dimColor>{props.hint}</Text>
      {phase === 'input' && (
        <Box borderStyle="round" borderColor={T.accent} borderLeft={false} borderRight={false} paddingX={1}>
          <Text color={T.accent}>{'❯ '}</Text>
          <MaskedInput masked onSubmit={handleSubmit} />
        </Box>
      )}
      {phase === 'validating' && <Text color={T.warn}>验证中…</Text>}
      {phase === 'error' && (
        <Box flexDirection="column">
          <Text color={T.err}>✗ {error}</Text>
          <Text dimColor>r 重录 · s 仍然保存并继续</Text>
        </Box>
      )}
      {phase === 'input' && <Text dimColor>{props.optional ? 'Enter 留空跳过 · Ctrl+C 取消' : 'Enter 确认 · Ctrl+C 取消'}</Text>}
    </>
  )
}

/** /model 切到未配 key 的 provider 时的就地录入：单 provider，无 provider 选择/搜索/vision 步。
 *  只验证+回传 key——是否写盘、是否继续切换由调用方（useChat.resolveKeyEntry）决定，本组件不碰 settings。 */
export function SoloKeyEntry(props: {
  label: string
  baseURL: string
  model: string
  onDone: (key: string) => void
  onCancel: () => void
}) {
  useInput((_input, key) => { if (key.escape) props.onCancel() })
  return (
    <WizardPanel title={`🐳 切换到 ${props.label}`}>
      <Text dimColor>尚未配置 API key，录入后立即切换（Esc 取消）</Text>
      <KeyInputStep
        title={`${props.label} API key`}
        hint="粘贴 key，回车验证"
        optional={false}
        validate={(k) => validateLlmKey({ apiKeyEnvOrKey: k, baseURL: props.baseURL, model: props.model })}
        onDone={(k) => { if (k) props.onDone(k); else props.onCancel() }}
      />
    </WizardPanel>
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
        <WizardPanel step={1}>
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
        </WizardPanel>
      )
    case 'customBaseURL':
      return (
        <WizardPanel step={1}>
          <TextInputStep
            key={step}
            title="自定义 provider · baseURL"
            hint="OpenAI 兼容 API 地址，例如 https://api.example.com/v1"
            onSubmit={(v) => { acc.current.customBaseURL = v; setStep('customFast') }}
          />
        </WizardPanel>
      )
    case 'customFast':
      return (
        <WizardPanel step={1}>
          <TextInputStep
            key={step}
            title="自定义 provider · fast 模型 id"
            hint="日常快档模型 id"
            onSubmit={(v) => { acc.current.customFast = v; setStep('customSmart') }}
          />
        </WizardPanel>
      )
    case 'customSmart':
      return (
        <WizardPanel step={1}>
          <TextInputStep
            key={step}
            title="自定义 provider · smart 模型 id"
            hint="重活/编码模型 id"
            onSubmit={(v) => { acc.current.customSmart = v; setStep('llmKey') }}
          />
        </WizardPanel>
      )
    case 'llmKey': {
      const preset = presetFor(acc.current)
      return (
        <WizardPanel step={2}>
          <KeyInputStep
            key={step}
            title={`${providerLabel(acc.current.provider)} API key`}
            hint="粘贴 key，回车验证"
            optional={false}
            validate={(k) => validateLlmKey({ apiKeyEnvOrKey: k, baseURL: preset.baseURL, model: preset.model })}
            onDone={(k) => { acc.current.llmKey = k; setStep('search-bocha') }}
          />
        </WizardPanel>
      )
    }
    case 'search-bocha':
      return (
        <WizardPanel step={3}>
          <KeyInputStep
            key={step}
            title="搜索 · Bocha（可选）"
            hint="open.bochaai.com 申请 key；Enter 留空跳过；留空跳过也能匿名搜（内置兜底）"
            optional
            validate={(k) => validateSearchKey('bocha', k)}
            onDone={(k) => { if (k) acc.current.bocha = k; setStep('search-tavily') }}
          />
        </WizardPanel>
      )
    case 'search-tavily':
      return (
        <WizardPanel step={3}>
          <KeyInputStep
            key={step}
            title="搜索 · Tavily（可选）"
            hint="tavily.com 申请 key；Enter 留空跳过"
            optional
            validate={(k) => validateSearchKey('tavily', k)}
            onDone={(k) => { if (k) acc.current.tavily = k; afterSearch() }}
          />
        </WizardPanel>
      )
    case 'vision':
      return (
        <WizardPanel step={4}>
          <KeyInputStep
            key={step}
            title="图片识别（可选）"
            hint="图片识别用 GLM，需智谱 ZHIPUAI_API_KEY（open.bigmodel.cn）；Enter 留空跳过"
            optional
            validate={(k) => validateVisionKey(k)}
            onDone={(k) => { if (k) acc.current.visionKey = k; finish() }}
          />
        </WizardPanel>
      )
  }
}

function DoneStep(props: { summary: string[]; onAny: () => void }) {
  useInput(() => { props.onAny() })
  return (
    <WizardPanel>
      <Text color={T.ok} bold>✓ 配置完成</Text>
      {props.summary.map((line, i) => <Text key={i}>{line}</Text>)}
      <Text dimColor>按任意键继续</Text>
    </WizardPanel>
  )
}

export async function runSetup(): Promise<void> {
  let inst: { unmount: () => void; waitUntilExit: () => Promise<void> }
  inst = render(<Setup onDone={() => inst.unmount()} onCancel={() => inst.unmount()} />, { exitOnCtrlC: true }) as any
  await inst.waitUntilExit()
}
