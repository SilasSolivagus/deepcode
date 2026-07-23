// src/providers.ts —— 多 provider 单一事实源（内置 deepseek/glm + custom）。
import { loadSettings, type Settings } from './config.js'

export type Dialect = 'deepseek' | 'glm' | 'openai' | 'kimi'

/** 每模型元数据。hit/miss/out = CNY/1M。 */
export interface ModelMeta {
  hit: number
  miss: number
  out: number
  contextWindow: number
  supportsThinking: boolean
  supportsVision?: boolean
  /** 只支持思考模式的模型（如 kimi-k2.7-code/k3）：发 thinking:{type:disabled} 会被端点 400 拒绝。
   *  buildThinkingParams 见此标记时，「关思考」不发 disabled 而是省略（让模型走其恒定思考默认）。 */
  thinkingOnly?: boolean
}

/** custom provider（用户在 settings.providers.custom 自填的 OpenAI 兼容后端）。 */
export interface CustomProvider {
  baseURL: string
  apiKeyEnv?: string
  apiKey?: string
  dialect?: Dialect
  models: { fast: string; smart: string }
  meta?: Record<string, ModelMeta>
  defaultMeta?: ModelMeta
}

export interface ProviderPreset {
  id: string
  baseURL: string
  apiKeyEnv: string
  dialect: Dialect
  /** 归属判定前缀（deepseek→'deepseek'、glm→'glm'）；custom 无前缀走 meta∪models 成员判定。 */
  modelPrefix?: string
  models: { fast: string; smart: string }
  meta: Record<string, ModelMeta>
  /** 未知档（未来 deepseek-v4.1/glm-5.3…）兜底，避免回落全局 200k/0。 */
  defaultMeta: ModelMeta
}

// 价格单位 CNY/1M（待核实 bigmodel.cn/pricing 的为 GLM 估值；deepseek 取自 pricing.ts 现值）。
const GLM_DEFAULT: ModelMeta = { hit: 0.6, miss: 3, out: 14, contextWindow: 200_000, supportsThinking: true } // 待核实

export const BUILTIN_PROVIDERS: Record<string, ProviderPreset> = {
  deepseek: {
    id: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    dialect: 'deepseek',
    modelPrefix: 'deepseek',
    models: { fast: 'deepseek-v4-flash', smart: 'deepseek-v4-pro' },
    meta: {
      'deepseek-v4-flash': { hit: 0.02, miss: 1, out: 2, contextWindow: 1_000_000, supportsThinking: true },
      'deepseek-v4-pro': { hit: 0.025, miss: 3, out: 6, contextWindow: 1_000_000, supportsThinking: true },
    },
    defaultMeta: { hit: 0.025, miss: 3, out: 6, contextWindow: 1_000_000, supportsThinking: true }, // = pro 保守兜底
  },
  glm: {
    id: 'glm',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnv: 'ZHIPUAI_API_KEY',
    dialect: 'glm',
    modelPrefix: 'glm',
    models: { fast: 'glm-5-turbo', smart: 'glm-5.2' },
    meta: { // hit/miss/out = CNY/1M，待核实 bigmodel.cn/pricing
      'glm-5.2': { hit: 1.85, miss: 10, out: 31, contextWindow: 1_000_000, supportsThinking: true },
      'glm-5.1': { hit: 1, miss: 5, out: 16, contextWindow: 200_000, supportsThinking: true },
      'glm-5': { hit: 1, miss: 5, out: 16, contextWindow: 200_000, supportsThinking: true },
      'glm-5-turbo': { hit: 0.2, miss: 1, out: 3, contextWindow: 200_000, supportsThinking: true },
      'glm-4.7': { hit: 0.6, miss: 3, out: 14, contextWindow: 200_000, supportsThinking: true },
      'glm-4.6': { hit: 0.6, miss: 3, out: 14, contextWindow: 200_000, supportsThinking: true },
      'glm-4.5': { hit: 0.6, miss: 3, out: 14, contextWindow: 128_000, supportsThinking: true },
      'glm-4.5-air': { hit: 0.2, miss: 1, out: 6, contextWindow: 128_000, supportsThinking: true },
      'glm-4.6v': { hit: 1, miss: 1, out: 3, contextWindow: 128_000, supportsThinking: true, supportsVision: true },
      'glm-4.6v-flash': { hit: 0, miss: 0, out: 0, contextWindow: 128_000, supportsThinking: true, supportsVision: true },
    },
    defaultMeta: GLM_DEFAULT,
  },
  kimi: {
    id: 'kimi',
    baseURL: 'https://api.moonshot.cn/v1',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    dialect: 'kimi',
    modelPrefix: 'kimi',
    // fast=kimi-k2.5（最便宜且支持非思考模式，记忆门控禁 thinking 才不被吃空）；
    // smart=kimi-k2.7-code（代码专用，仅思考模式）。/model 可切 k3（1M 上下文）。
    models: { fast: 'kimi-k2.5', smart: 'kimi-k2.7-code' },
    meta: { // hit/miss/out = CNY/1M，取自 platform.kimi.com/docs/pricing（2026-07 核实）
      'kimi-k3': { hit: 2, miss: 20, out: 100, contextWindow: 1_048_576, supportsThinking: true, thinkingOnly: true },
      'kimi-k2.7-code': { hit: 1.3, miss: 6.5, out: 27, contextWindow: 262_144, supportsThinking: true, thinkingOnly: true, supportsVision: true },
      'kimi-k2.7-code-highspeed': { hit: 2.6, miss: 13, out: 54, contextWindow: 262_144, supportsThinking: true, thinkingOnly: true, supportsVision: true },
      'kimi-k2.6': { hit: 1.1, miss: 6.5, out: 27, contextWindow: 262_144, supportsThinking: true, supportsVision: true },
      'kimi-k2.5': { hit: 0.7, miss: 4, out: 21, contextWindow: 262_144, supportsThinking: true, supportsVision: true },
    },
    // 未知 kimi 新档兜底（取 k2.6 保守值，不设 thinkingOnly 以免误伤门控）。
    defaultMeta: { hit: 1.1, miss: 6.5, out: 27, contextWindow: 262_144, supportsThinking: true },
  },
}

export function resolveActiveProvider(settings: Settings): ProviderPreset {
  const id = settings.provider ?? 'deepseek'
  if (id === 'custom') {
    const c = settings.providers?.custom
    if (!c || !c.baseURL || !c.models) return BUILTIN_PROVIDERS.deepseek
    return {
      id: 'custom',
      baseURL: c.baseURL,
      apiKeyEnv: c.apiKeyEnv ?? 'DEEPCODE_API_KEY',
      dialect: c.dialect ?? 'openai',
      modelPrefix: undefined,
      models: c.models,
      meta: c.meta ?? {},
      defaultMeta: c.defaultMeta ?? { hit: 0, miss: 0, out: 0, contextWindow: 200_000, supportsThinking: false },
    }
  }
  return BUILTIN_PROVIDERS[id] ?? BUILTIN_PROVIDERS.deepseek
}

export function modelMeta(preset: ProviderPreset, modelId: string): ModelMeta {
  return preset.meta[modelId] ?? preset.defaultMeta
}

export function belongsToProvider(preset: ProviderPreset, modelId: string): boolean {
  if (preset.modelPrefix) return modelId.startsWith(preset.modelPrefix + '-') || modelId === preset.modelPrefix
  return modelId in preset.meta || modelId === preset.models.fast || modelId === preset.models.smart
}

/** 可切换的 provider 全集：内置 + 配置齐备的 custom（配置不全的 custom 会回落 deepseek，列出来只会造成静默错投）。 */
export function availablePresets(settings: Settings): ProviderPreset[] {
  const out = Object.values(BUILTIN_PROVIDERS)
  const c = settings.providers?.custom
  if (c?.baseURL && c.models) out.push(resolveActiveProvider({ ...settings, provider: 'custom' }))
  return out
}

/** settings.provider 的合法取值（availablePresets 的 id 恒在此集合内）。 */
export type ProviderId = NonNullable<Settings['provider']>

/**
 * 全局 settings.apiKey 是单 provider 时代的遗留（首跑向导 saveApiKey 写的就是它），**归属 deepseek**。
 * custom 是用户自建端点、key 也由他自己配，沿用全局 key 属于他自己的选择，故一并认。
 * 但绝不能把它当作**别的内置厂商**（glm 及将来新增）的 key——那会把这家的密钥发到另一家的端点（凭证外泄 + 401）。
 * 认「归属」而非认「当前 active」：否则向导装机的用户切到 GLM 后就再也切不回 deepseek（单向门）。
 */
export function legacyGlobalKeyApplies(preset: ProviderPreset): boolean {
  return preset.id === 'deepseek' || preset.id === 'custom'
}

/** 目标 provider 的 key 是否就绪：env[apiKeyEnv] → providers.<id>.apiKey → （仅归属者）全局 apiKey。 */
export function providerKeyReady(preset: ProviderPreset, settings: Settings): boolean {
  const perProvider = settings.providers as Record<string, { apiKey?: string } | undefined> | undefined
  if (process.env[preset.apiKeyEnv] || perProvider?.[preset.id]?.apiKey) return true
  return legacyGlobalKeyApplies(preset) && Boolean(settings.apiKey)
}

/** 任意内置 provider（含配置齐全的 custom）的 key 已就绪——只要配了其中一家就不算「未配置」。 */
export function anyProviderKeyReady(settings: Settings): boolean {
  return availablePresets(settings).some(p => providerKeyReady(p, settings))
}

/**
 * 模型 id 明确归属于「另一个」provider 时返回那个 provider id，否则 undefined。
 * client 在启动时按 active preset 建好（baseURL+key 固定），用别家的 model id 发请求会被静默打到错误端点，故需识别。
 * 无人认领的未知档（provider 的未来新档）不算外来，避免误伤。presets 默认只认内置；
 * 需要认得 custom 时由调用方传 availablePresets(settings)。
 */
export function foreignProviderOf(
  preset: ProviderPreset,
  modelId: string,
  presets: ProviderPreset[] = Object.values(BUILTIN_PROVIDERS),
): string | undefined {
  if (belongsToProvider(preset, modelId)) return undefined
  for (const p of presets) {
    if (p.id !== preset.id && belongsToProvider(p, modelId)) return p.id
  }
  return undefined
}

/** 启动期 model 解析：配置的 model 属于别家 provider 时回落 active fast（防错投），其余原样。 */
export function resolveStartupModel(
  configured: string | undefined,
  preset: ProviderPreset,
  presets?: ProviderPreset[],
): string {
  if (!configured) return preset.models.smart // 未配置 → 默认用智能档（deepseek 即 deepseek-v4-pro）
  return foreignProviderOf(preset, configured, presets) ? preset.models.fast : configured
}

const PROVIDER_LABELS: Record<string, string> = { deepseek: 'DeepSeek', glm: 'GLM', kimi: 'Kimi', custom: 'Custom' }
/** provider 展示名（横幅、选择器标签用）。 */
export function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id
}

let _cachedProvider: ProviderPreset | undefined
/** 便利封装：读 settings 解析 active preset（结果 memoize，provider 运行期锁定）。 */
export function activeProvider(): ProviderPreset {
  return (_cachedProvider ??= resolveActiveProvider(loadSettings()))
}
/** 测试用：清 active provider 缓存（运行期 provider 锁定，仅测试切换 mock 时需重置）。 */
export function __resetProviderCache(): void { _cachedProvider = undefined }
export function activeModelMeta(modelId: string): ModelMeta {
  return modelMeta(activeProvider(), modelId)
}
/** 按模型 id 的**归属** provider 解析 context window（不受当前 active provider 影响）。
 *  归属靠 belongsToProvider 在内置 preset 里找；无人认领的未知 id 回落 active provider defaultMeta。
 *  修复：active=glm 时显示 deepseek-v4-pro 曾误取 GLM defaultMeta(200k)。 */
export function contextWindowFor(modelId: string): number {
  for (const p of Object.values(BUILTIN_PROVIDERS)) {
    if (belongsToProvider(p, modelId)) return modelMeta(p, modelId).contextWindow
  }
  return activeModelMeta(modelId).contextWindow
}
export function activeFastModel(): string {
  return activeProvider().models.fast
}
export function activeSmartModel(): string {
  return activeProvider().models.smart
}

/** 子调用 model 档解析（运行时第二段）：inherit/undefined→父；flash/fast→active fast；smart→active smart；具体 id→透传。 */
export function resolveSubModel(alias: string | undefined, parent: string): string {
  if (!alias || alias === 'inherit') return parent
  if (alias === 'flash' || alias === 'fast') return activeFastModel()
  if (alias === 'smart') return activeSmartModel()
  return alias
}

export interface ModelListItem {
  id: string
  label: string
  /** 该档所属 provider（allModelList 才填；跨 provider 选中时据此切换）。 */
  providerId?: string
  /** 该 provider 的 key 是否就绪（未就绪的档选中会被拒，不重启）。 */
  ready?: boolean
}

function formatWindow(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** /model 选择器列表：fast/smart 别名行（解析到具体 id）+ 全部 meta 档。current 行带 ● 标记。 */
export function modelList(preset: ProviderPreset, current: string): ModelListItem[] {
  const mark = (id: string) => (id === current ? '● ' : '  ')
  const metaLabel = (id: string) => {
    const m = preset.meta[id] ?? preset.defaultMeta
    return `${formatWindow(m.contextWindow)} · 命中¥${m.hit}/未命中¥${m.miss}/输出¥${m.out} 每百万`
  }
  const out: ModelListItem[] = []
  out.push({ id: preset.models.fast, label: `${mark(preset.models.fast)}[fast] ${preset.models.fast}（${metaLabel(preset.models.fast)}）` })
  out.push({ id: preset.models.smart, label: `${mark(preset.models.smart)}[smart] ${preset.models.smart}（${metaLabel(preset.models.smart)}）` })
  for (const id of Object.keys(preset.meta)) {
    out.push({ id, label: `${mark(id)}${id}（${metaLabel(id)}）` })
  }
  return out
}

/** 跨 provider 的 /model 列表：当前 provider 的档在前，其它 provider 的档随后（带 provider 名与 key 就绪标记）。 */
export function allModelList(settings: Settings, current: string): ModelListItem[] {
  const active = resolveActiveProvider(settings)
  const out: ModelListItem[] = modelList(active, current).map(i => ({ ...i, providerId: active.id, ready: true }))
  for (const p of availablePresets(settings)) {
    if (p.id === active.id) continue
    const ready = providerKeyReady(p, settings)
    const tag = ready ? ` · ${providerLabel(p.id)}` : ` · ${providerLabel(p.id)}（未配置 ${p.apiKeyEnv}）`
    for (const i of modelList(p, current)) {
      out.push({ ...i, providerId: p.id, ready, label: `${i.label}${tag}` })
    }
  }
  return out
}

export type { Settings }
