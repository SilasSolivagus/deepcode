---
title: settings 参考
---
# settings 参考

`settings.json` 的**全部字段**。位置、分层合并规则与常用配置见
[配置 / settings 与环境变量](/config/settings)，这一页是全表。

所有字段都是可选的（除 `permissions` / `costWarnCNY` / `maxToolResultChars` 有内置缺省外，
不写就是不启用）。

## 模型与 provider

| 字段 | 类型 | 说明 |
|---|---|---|
| `model` | `string` | 启动默认模型。不设＝内置缺省 |
| `availableModels` | `string[]` | model 白名单。设了就必须命中其一，否则忽略所配模型、回落默认档。**不设＝全允许，`[]`＝仅默认档** |
| `provider` | `'deepseek' \| 'glm' \| 'kimi' \| 'custom'` | active provider，缺省 `deepseek` |
| `providers` | 对象 | 各 provider 的 apiKey 覆盖 + `custom` 后端定义 |
| `apiKey` | `string` | DeepSeek key（首跑向导写入）。**环境变量优先级更高** |
| `baseURL` | `string` | 自定义 API baseURL |
| `language` | `string` | 响应语言锁定：设了就往系统提示注入「始终用 X 回复」 |

## 上下文与压缩

| 字段 | 类型 | 说明 |
|---|---|---|
| `compactTokens` | `number` | 自动压缩触发阈值（上次请求的 prompt_tokens 超过即触发）。不设＝走按模型派生的阈值 |
| `precomputeCompactionEnabled` | `boolean` | 预处理压缩，缺省开；**仅 `=== false` 才关** |
| `maxToolResultChars` | `number` | 工具结果字符上限，超出截断后再回灌。缺省 100000 |

派生阈值 = 上下文窗口 − 输出预留(16k) − 自动压缩缓冲(13k)。窗口可用
`DEEPCODE_MAX_CONTEXT_TOKENS` 覆盖。

## headless 专用

| 字段 | 类型 | 说明 |
|---|---|---|
| `headlessThinking` | `boolean` | headless 是否开 thinking，缺省 `false` |
| `headlessMaxTurns` | `number` | headless 单轮最大工具循环步数，不设＝ 80 |

::: info 为什么带 headless 前缀
TUI 的 thinking 是会话状态（`/think` 切换、存进 session meta），headless 没有会话状态可继承，
所以单列开关。**做成开关而不是直接改默认值**：思考会增加 token 与轮次，划不划算得靠 A/B 测——
默认改了就没有干净的基线可比。步数同理，且它只被 headless 消费（TUI 仍走 80），
名字带前缀就是为了避免误以为它是全局旋钮。
:::

## 权限

| 字段 | 类型 | 说明 |
|---|---|---|
| `permissions.allow` | `string[]` | 放行规则 |
| `permissions.deny` | `string[]` | 拒绝规则，**优先级最高** |
| `permissions.ask` | `string[]` | 强制询问规则 |
| `permissions.defaultMode` | `PermissionMode` | 启动默认权限模式 |
| `disableAutoMode` | `boolean` | 禁用 auto 模式，缺省 `false` |
| `autoModeModel` | `string` | auto 分类器覆盖模型，缺省走 provider 的 fast 档 |
| `autoModeThinking` | `boolean` | auto 分类器是否开 thinking，缺省 `false` |

## 生态与扩展

| 字段 | 类型 | 说明 |
|---|---|---|
| `hooks` | 对象 | hooks 生命周期配置 |
| `mcpServers` | `Record<string, ...>` | MCP server（stdio），键＝server 名 |
| `skills` | 对象 | 技能发现范围 + 清单预算；缺省全扫全可调用 |
| `skillOverrides` | 对象 | 单个技能的开关覆盖 |
| `webSearch` | 对象 | WebSearch 双源（bocha / tavily）配置 |
| `worktree` | 对象 | git worktree 配置（`symlinkDirectories` / `sparsePaths`） |
| `memory` | 对象 | 记忆子系统配置 |

## 安全

| 字段 | 类型 | 说明 |
|---|---|---|
| `allowedHttpHookUrls` | `string[]` | hook URL 白名单（SSRF）。**不设＝不限制，`[]`＝全禁**，非空＝须匹配通配模式 |
| `httpHookAllowedEnvVars` | `string[]` | http hook header 里 env 插值的全局白名单，与每个 hook 自身的 `allowedEnvVars` 取交集 |

::: warning SSRF 防护只覆盖 hook
两层 SSRF 防护只在 hook 的 HTTP 请求上生效；`WebSearch` / `WebFetch` 走的是另一条路径。
:::

## 界面

| 字段 | 类型 | 说明 |
|---|---|---|
| `theme` | `string` | 主题名，不设＝运行期兜底 dark |
| `tui` | `'inline' \| 'fullscreen'` | 渲染器，不设＝走决策链（默认 fullscreen） |
| `inline` | `boolean` | 启动用内联模式。`DEEPCODE_INLINE=1` 与 `--inline` 优先级更高 |
| `viewMode` | `'default' \| 'focus'` | 启动初始视图。`'focus'`＝启动即开且**锁定**折叠视图 |
| `outputStyle` | `string` | 输出风格名 |
| `statusLineCommand` | `string` | 自定义状态栏命令，取其 stdout 附加到状态栏 |
| `spinnerTips` | `boolean` | spinner 提示轮播，缺省开 |
| `spinnerTipsOverride` | 对象 | 自定义提示语（`tips` / `excludeDefault`） |

## 成本与通知

| 字段 | 类型 | 说明 |
|---|---|---|
| `costWarnCNY` | `number` | 本会话花费提醒阈值，状态行**变色一次** |
| `preferredNotifChannel` | | 桌面通知渠道，不设＝ auto＝默认开 |
| `messageIdleNotifThresholdMs` | `number` | 空闲多久无输入自动发桌面通知，缺省 60000 |

## 会话与 git

| 字段 | 类型 | 说明 |
|---|---|---|
| `cleanupPeriodDays` | `number` | 会话历史保留天数，启动时删超龄 `.jsonl`。**不设或 ≤0 ＝不清理** |
| `attribution` | `{ commit?, pr? }` | git 署名文本覆盖；空串＝隐藏 |
| `includeCoAuthoredBy` | `boolean` | **已弃用**，用 `attribution` 代替 |
| `autoUpdates` | `boolean` | 是否允许后台自动升级 |

## 工作流

| 字段 | 类型 | 说明 |
|---|---|---|
| `workflowKeywordTriggerEnabled` | `boolean` | 关键字自动触发 Workflow 引导，缺省开 |
| `skipWorkflowUsageWarning` | `boolean` | 跳过多智能体消费警告，缺省 `false` |
| `doneMeansMerged` | `boolean` | `/loop` 自主模式的结束判定：合并即视为任务完成 |

## 分层与「危险字段剥离」

配置按 `user` → `project` → `local` → `flag` 四层合并，后者覆盖前者。

**但项目层（仓库里的配置）会被剥掉一批键**——因为项目配置可能来自不受信任的仓库：

```
apiKey  baseURL  hooks  mcpServers  webSearch
allowedHttpHookUrls  httpHookAllowedEnvVars
provider  providers  statusLineCommand
autoModeModel  autoModeThinking  disableAutoMode
language  cleanupPeriodDays
attribution  includeCoAuthoredBy
skillOverrides  autoUpdates  availableModels
```

每一条都有具体的攻击面，不是一刀切：

| 键 | 项目层可写会怎样 |
|---|---|
| `language` | 内容进系统提示 → prompt 注入通道 |
| `cleanupPeriodDays` | 恶意仓库可静默删掉你的会话历史 |
| `attribution` / `includeCoAuthoredBy` | 抹掉 AI 归属署名 |
| `skillOverrides` | 把你在 user 层禁用的技能重新打开 |
| `autoUpdates` | 操纵是否后台改动你机器上的全局安装 |
| `availableModels` | 它是 `model` 的白名单闸门；项目层可写＝可把贵档模型放进白名单，**钳制形同虚设** |
| `statusLineCommand` | 任意命令执行 |

被剥离时不会静默——启动会在 stderr 提示哪些键被剥掉了。用 `/config` 可以查看合并后的配置
与每一项的来源层。
