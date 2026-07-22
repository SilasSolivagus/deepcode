---
title: Providers
---

# Multi-provider

deepcode ships with three built-in backends (DeepSeek / GLM / Kimi·Moonshot), plus an OpenAI-compatible `custom` slot that can point at any self-hosted or third-party OpenAI-compatible endpoint. All four share the same main loop, tools, and permission system — switching backends just swaps the key and baseURL, everything else works the same.

## The four backends

| provider | env key | baseURL | smart (main loop) | fast (sub-operations) |
| --- | --- | --- | --- | --- |
| `deepseek` (default) | `DEEPSEEK_API_KEY` | `https://api.deepseek.com` | `deepseek-v4-pro` | `deepseek-v4-flash` |
| `glm` | `ZHIPUAI_API_KEY` | `https://open.bigmodel.cn/api/paas/v4` | `glm-5.2` | `glm-5-turbo` |
| `kimi` | `MOONSHOT_API_KEY` | `https://api.moonshot.cn/v1` | `kimi-k2.7-code` (thinking-only) | `kimi-k2.5` |
| `custom` | user-defined (defaults to `DEEPCODE_API_KEY`) | your own | your own | your own |

If `provider` is unset it defaults to `deepseek`.

## Configuring a provider

### Option 1: environment variable

Simplest, works out of the box. Each provider only reads its own env var:

```bash
export DEEPSEEK_API_KEY=sk-...
# or
export ZHIPUAI_API_KEY=...
# or
export MOONSHOT_API_KEY=...
```

### Option 2: `~/.deepcode/settings.json`

Use `provider` to pick the active backend and `providers.{}` to hold each provider's key (or a custom endpoint definition). Three examples:

**Switch to GLM:**

```jsonc
{
  "provider": "glm",
  "providers": {
    "glm": { "apiKey": "sk-..." }
  }
}
```

**Switch to Kimi:**

```jsonc
{
  "provider": "kimi",
  "providers": {
    "kimi": { "apiKey": "sk-..." }
  }
}
```

**Point at a self-hosted / third-party OpenAI-compatible endpoint (`custom`):**

```jsonc
{
  "provider": "custom",
  "providers": {
    "custom": {
      "baseURL": "https://your-endpoint.example.com/v1",
      "apiKeyEnv": "MY_ENDPOINT_API_KEY", // defaults to DEEPCODE_API_KEY
      "dialect": "openai",                // deepseek | glm | kimi | openai
      "models": { "fast": "your-fast-model", "smart": "your-smart-model" }
    }
  }
}
```

`custom.baseURL` plus `custom.models.fast`/`models.smart` are required — missing either one means the config is treated as incomplete and silently falls back to `deepseek`. `dialect` only accepts `deepseek`/`glm`/`kimi`/`openai`; anything else is discarded. Both `providers` and `provider` only take effect at the user layer (`~/.deepcode/settings.json`) — project-layer settings are stripped, so a shared repo's config can't quietly hijack which provider your key gets sent to.

## Switching at runtime: `/model`

Type `/model` in the interactive TUI to open the picker (or `/model <name>` to switch directly). The list shows the current provider's tiers first, followed by tiers from other providers that already have a key configured.

- Switching within the same provider (e.g. deepseek fast ↔ smart): instant, no restart.
- Switching to a different provider (e.g. deepseek → GLM): needs a process restart, which deepcode handles for you automatically — it saves the setting, exits, and relaunches with `--resume`, restoring your session history exactly, just on a different backend.

If the target provider has no key configured, the picker marks it as unconfigured and refuses the switch, so you never restart into a backend that can't actually connect.

## smart / fast tiers

Every provider has two tiers: **smart** for the main loop — planning, writing code, making decisions — and **fast** for cheaper, quicker sub-operations (subagents, summarization, etc). Defaults are in the table above.

Full built-in model list per provider (models marked "thinking-only" can't have thinking disabled — see below):

**DeepSeek**: `deepseek-v4-flash`, `deepseek-v4-pro`

**GLM**: `glm-5.2`, `glm-5.1`, `glm-5`, `glm-5-turbo`, `glm-4.7`, `glm-4.6`, `glm-4.5`, `glm-4.5-air`, `glm-4.6v`, `glm-4.6v-flash`

**Kimi**: `kimi-k3` (thinking-only), `kimi-k2.7-code` (thinking-only), `kimi-k2.7-code-highspeed` (thinking-only), `kimi-k2.6`, `kimi-k2.5`

## Thinking toggle & the thinking-only guard

Thinking defaults to **`disabled`** — saves tokens, responds faster. `/think` toggles it on/off, `/effort low|medium|high` adjusts how hard it thinks.

Some models are thinking-only — sending `thinking:{type:"disabled"}` gets flatly rejected by the endpoint (the Kimi tiers marked above). deepcode guards against this: for those models, turning thinking off doesn't send `disabled` at all, it omits the field entirely so the model falls back to whatever thinking behavior it always uses — turning thinking off never breaks the request.

## Pricing

See each vendor's own website for current pricing.

---

Next: [Settings & env vars](/en/config/settings).
