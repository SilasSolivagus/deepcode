---
title: Settings reference
---
# Settings reference

**Every field** in `settings.json`. For file locations, layer-merge rules and common configuration
see [Configuration / settings & environment](/en/config/settings); this page is the full table.

Every field is optional (aside from built-in defaults for `permissions` / `costWarnCNY` /
`maxToolResultChars`) — leaving one out means the feature is off.

## Model & provider

| Field | Type | Notes |
|---|---|---|
| `model` | `string` | Startup model. Unset = built-in default |
| `availableModels` | `string[]` | Allowlist for `model`. If set, `model` must be in it or it's ignored and falls back to the default tier. **Unset = everything allowed; `[]` = default tier only** |
| `provider` | `'deepseek' \| 'glm' \| 'kimi' \| 'custom'` | Active provider, default `deepseek` |
| `providers` | object | Per-provider apiKey overrides plus the `custom` backend definition |
| `apiKey` | `string` | DeepSeek key (written by the first-run wizard). **Environment variables win** |
| `baseURL` | `string` | Custom API base URL |
| `language` | `string` | Lock the reply language by injecting "always answer in X" into the system prompt |

## Context & compaction

| Field | Type | Notes |
|---|---|---|
| `compactTokens` | `number` | Auto-compaction threshold (triggers when the previous request's prompt_tokens exceeds it). Unset = derived from the model |
| `precomputeCompactionEnabled` | `boolean` | Precomputed compaction, on by default; **only `=== false` turns it off** |
| `maxToolResultChars` | `number` | Character cap on tool results before truncation. Default 100000 |

Derived threshold = context window − output reserve (16k) − autocompact buffer (13k). The window
can be overridden with `DEEPCODE_MAX_CONTEXT_TOKENS`.

## Headless only

| Field | Type | Notes |
|---|---|---|
| `headlessThinking` | `boolean` | Whether headless enables thinking. Default `false` |
| `headlessMaxTurns` | `number` | Tool-loop step cap for headless. Unset = 80 |

::: info Why the headless prefix
In the TUI, thinking is session state (`/think` toggles it, stored in session meta). Headless has
no session state to inherit, so it gets its own switch. **It's a switch rather than a changed
default** because thinking costs tokens and turns — whether it pays off has to be A/B tested, and
changing the default leaves no clean baseline to compare against. Same reasoning for the step cap,
which only headless consumes (the TUI still uses 80); the prefix is there so nobody mistakes it for
a global knob.
:::

## Permissions

| Field | Type | Notes |
|---|---|---|
| `permissions.allow` | `string[]` | Allow rules |
| `permissions.deny` | `string[]` | Deny rules, **highest priority** |
| `permissions.ask` | `string[]` | Force-prompt rules |
| `permissions.defaultMode` | `PermissionMode` | Startup permission mode |
| `disableAutoMode` | `boolean` | Disable auto mode. Default `false` |
| `autoModeModel` | `string` | Override model for the auto classifier. Default: the provider's fast tier |
| `autoModeThinking` | `boolean` | Enable thinking for the classifier. Default `false` |

## Ecosystem & extensions

| Field | Type | Notes |
|---|---|---|
| `hooks` | object | Hook lifecycle configuration |
| `mcpServers` | `Record<string, ...>` | MCP servers (stdio); key = server name |
| `skills` | object | Skill discovery scope + listing budget. Default: scan everything, allow everything |
| `skillOverrides` | object | Per-skill on/off overrides |
| `webSearch` | object | WebSearch dual-source (bocha / tavily) configuration |
| `worktree` | object | git worktree config (`symlinkDirectories` / `sparsePaths`) |
| `memory` | object | Memory subsystem configuration |

## Security

| Field | Type | Notes |
|---|---|---|
| `allowedHttpHookUrls` | `string[]` | Hook URL allowlist (SSRF). **Unset = unrestricted, `[]` = block all**, non-empty = must match a glob |
| `httpHookAllowedEnvVars` | `string[]` | Global allowlist for env interpolation in http hook headers; intersected with each hook's own `allowedEnvVars` |

::: warning SSRF protection only covers hooks
The two-layer SSRF guard applies to hook HTTP requests only. `WebSearch` and `WebFetch` take a
different path.
:::

## Interface

| Field | Type | Notes |
|---|---|---|
| `theme` | `string` | Theme name. Unset = runtime fallback to dark |
| `tui` | `'inline' \| 'fullscreen'` | Renderer. Unset = decision chain (fullscreen by default) |
| `inline` | `boolean` | Start inline. `DEEPCODE_INLINE=1` and `--inline` take precedence |
| `viewMode` | `'default' \| 'focus'` | Initial view. `'focus'` starts in — and **locks** — the collapsed view |
| `outputStyle` | `string` | Output style name |
| `statusLineCommand` | `string` | Custom status-line command; its stdout is appended to the status line |
| `spinnerTips` | `boolean` | Rotating spinner tips, on by default |
| `spinnerTipsOverride` | object | Custom tips (`tips` / `excludeDefault`) |

## Cost & notifications

| Field | Type | Notes |
|---|---|---|
| `costWarnCNY` | `number` | Spend warning threshold; the status line changes color **once** |
| `preferredNotifChannel` | | Desktop notification channel. Unset = auto = on |
| `messageIdleNotifThresholdMs` | `number` | Idle time before a desktop notification fires. Default 60000 |

## Sessions & git

| Field | Type | Notes |
|---|---|---|
| `cleanupPeriodDays` | `number` | Session retention in days; over-age `.jsonl` files are deleted at startup. **Unset or ≤0 = never clean up** |
| `attribution` | `{ commit?, pr? }` | Override git attribution text; empty string hides it |
| `includeCoAuthoredBy` | `boolean` | **Deprecated** — use `attribution` |
| `autoUpdates` | `boolean` | Whether background auto-upgrade is allowed |

## Workflows

| Field | Type | Notes |
|---|---|---|
| `workflowKeywordTriggerEnabled` | `boolean` | Keyword-triggered Workflow guidance, on by default |
| `skipWorkflowUsageWarning` | `boolean` | Skip the multi-agent spend warning. Default `false` |
| `doneMeansMerged` | `boolean` | `/loop` autonomous mode: treat "merged" as task completion |

## Layers and "dangerous key" stripping

Configuration merges across four layers — `user` → `project` → `local` → `flag` — each overriding
the last.

**But the project layer (config committed in a repo) has a set of keys stripped out**, because
project config may come from a repository you don't trust:

```
apiKey  baseURL  hooks  mcpServers  webSearch
allowedHttpHookUrls  httpHookAllowedEnvVars
provider  providers  statusLineCommand
autoModeModel  autoModeThinking  disableAutoMode
language  cleanupPeriodDays
attribution  includeCoAuthoredBy
skillOverrides  autoUpdates  availableModels
```

Each one is on the list for a specific reason, not as a blanket rule:

| Key | What a hostile repo could do with it |
|---|---|
| `language` | Its contents land in the system prompt — a prompt-injection channel |
| `cleanupPeriodDays` | Silently delete your session history |
| `attribution` / `includeCoAuthoredBy` | Erase AI attribution |
| `skillOverrides` | Re-enable skills you disabled at the user layer |
| `autoUpdates` | Influence whether your global install gets modified in the background |
| `availableModels` | It's the gate on `model`; writable from a repo means expensive tiers can be added to the allowlist and **the clamp becomes meaningless** |
| `statusLineCommand` | Arbitrary command execution |

Stripping is never silent — startup reports which keys were dropped on stderr. `/config` shows the
merged configuration along with the source layer of every key.
