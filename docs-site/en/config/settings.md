---
title: Settings & env
---

# Settings & env

deepcode's configuration is split into four layers that get merged into one effective settings object at runtime. This page covers: where the files live, how they merge, which fields get stripped, the most common keys, and environment variables.

## Location

| Layer | Path | Purpose |
| --- | --- | --- |
| user | `~/.deepcode/settings.json` (mode 600) | Personal, global config — the only layer trusted for sensitive fields like provider keys |
| project | `<repo>/.deepcode/settings.json` | Committed to the repo, shared config for the whole team |
| local | `<repo>/.deepcode/settings.local.json` | Personal overrides for a project, usually `.gitignore`d |
| flag | `--settings <path>` | Explicit config file passed on the command line, highest priority |

## Layer merge

Precedence is **user < project < local < flag**: a later layer overrides an earlier layer's same-named field. Array/object fields are merged with de-duplication (e.g. if two layers both set `permissions.allow`, the effective value is the union); scalar fields (e.g. `model`) take whichever layer wrote them last.

To see which layer a given field's effective value came from, run `/config` — it shows the source layer per field, and marks array/object fields contributed by multiple layers as "merged".

## Dangerous-field stripping

Project-layer config ships with the repo and anyone on the team can edit it, so it can't be fully trusted — a malicious or compromised repo shouldn't be able to rewrite your API key, silently swap in hooks that run arbitrary commands, or turn off your safety prompts just by shipping a `settings.json`. So when deepcode loads the project layer (and any local layer that's tracked by git — i.e. actually committed to the repo), it strips the following keys entirely, trusting only the same fields in the user layer (or an untracked, uncommitted local layer):

```
apiKey, baseURL, hooks, mcpServers, webSearch,
allowedHttpHookUrls, httpHookAllowedEnvVars,
provider, providers, statusLineCommand,
autoModeModel, autoModeThinking, disableAutoMode,
language, cleanupPeriodDays,
attribution, includeCoAuthoredBy,
skillOverrides
```

Plus three nested fields: `permissions.allow`, `permissions.defaultMode`, and `skills.sources`.

In other words: the project layer can set non-sensitive fields like `permissions.deny`/`permissions.ask` (tightening permissions is fine), `worktree`, or `viewMode` — but it can't set API keys, hooks, MCP servers, or a custom status-line command, since those can read secrets or execute code. Those are only trusted from the user layer (or your own uncommitted `settings.local.json`).

`/config` also flags whether a field was stripped, and from which layer, which helps debug "why does this project-level field not take effect".

## Common keys

Not the complete dictionary — just the high-frequency fields; see the reference for the full list:

- `provider` / `providers`: the active provider backend + each provider's apiKey (user layer only — see [multi-provider config](/en/config/providers)).
- `permissions.allow` / `deny` / `ask` / `defaultMode`: permission rules and the default mode.
- `model`: the default startup model (falls back to the built-in default `deepseek-v4-pro` if unset).
- `worktree`: git worktree isolation config (symlinked directories, sparse paths).
- `statusLineCommand`: a custom status-line command (user layer only).
- `viewMode` / `tui`: `focus`/`default` view and `inline`/`fullscreen` render mode.
- `costWarnCNY`: the per-session cost warning threshold (CNY).

Example (`~/.deepcode/settings.json`):

```jsonc
{
  "provider": "glm",
  "providers": {
    "glm": { "apiKey": "sk-..." }
  },
  "permissions": {
    "allow": ["Bash(npm test)"],
    "ask": ["Bash(git push*)"],
    "deny": ["Read(**/.env)"]
  },
  "model": "deepseek-v4-pro",
  "costWarnCNY": 15,
  "viewMode": "focus"
}
```

## Environment variables

Each provider's key is read from an environment variable first, with `apiKey`/`providers.*.apiKey` in settings.json as a lower-priority fallback:

| Variable | Purpose |
| --- | --- |
| `DEEPSEEK_API_KEY` | DeepSeek key |
| `ZHIPUAI_API_KEY` | GLM (Zhipu) key |
| `MOONSHOT_API_KEY` | Kimi (Moonshot) key |
| `DEEPCODE_API_KEY` | Default key for the `custom` provider (override the variable name with `apiKeyEnv`) |
| `BOCHA_API_KEY` / `TAVILY_API_KEY` | WebSearch dual-source keys (take priority over `settings.webSearch`) |
| `https_proxy` / `HTTPS_PROXY` / `http_proxy` / `HTTP_PROXY` | Outbound proxy, read automatically, no extra config needed |

## SSRF protection

HTTP requests from hooks and WebSearch go through two layers of protection: first an `allowedHttpHookUrls` allowlist (unset = unrestricted, `[]` = fully blocked, non-empty = must match a glob pattern), then a network-layer IP guard (blocking private/internal addresses and DNS rebinding), with redirects disallowed. When a proxy is active, the proxy handles DNS resolution and the guard steps aside.

---

See [Settings reference](/en/reference/settings) for the complete field list.
