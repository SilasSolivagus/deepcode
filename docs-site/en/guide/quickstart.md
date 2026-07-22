---
title: Quickstart
---

# Quickstart

## Install

Node ≥ 22.5:

```bash
npm i -g @silassolivagus/deepcode
```

## First run

Just run `deepcode`. On first launch a wizard prompts you to paste your key (written to `~/.deepcode/settings.json`, mode 600):

```bash
deepcode
```

If you already have a key, skip the wizard and set an environment variable instead:

```bash
export DEEPSEEK_API_KEY=sk-...
deepcode
```

The default model is `deepseek-v4-pro`. To switch to GLM / Kimi / a self-hosted backend, see [multi-provider config](/en/config/providers).

## Your first task

Once you're in the interactive TUI, just describe the task:

```
> add unit tests for utils and make them pass
```

deepcode plans, calls tools, and runs the tests itself. A typical turn looks like this:

```
› add unit tests for utils and make them pass

  Grep  search for utils-related files
  Read  src/utils.ts
  Edit  src/utils.test.ts
  Bash  npm test

  Added unit tests for the 4 functions in utils.ts, npm test passes (12 passed).

  ¥0.03 · 3 turns · 8.2k tokens
```

Grep → Read → Edit → self-test, then a cost line at the end — the whole run is visible and interruptible.

For a one-shot result without entering the interactive UI, use headless mode:

```bash
deepcode -p "add unit tests for utils and make them pass"
```

For structured output (scripting / CI), add `--json`, which includes `text` / `status` / `turns` / `usage` / `costCNY`:

```bash
deepcode -p "add unit tests for utils and make them pass" --json
```

## Next steps

- [Multi-provider config](/en/config/providers): switch between DeepSeek / GLM / Kimi / self-hosted backends.
- [Commands](/en/usage/commands): `/model`, `/think`, `/plan`, `/cost`, and other common commands.
- [How it works](/en/guide/how-it-works): the main loop, tools, permissions, and memory architecture.
