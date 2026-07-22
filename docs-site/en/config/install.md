---
title: Install & update
---

# Install & update

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

The default model is `deepseek-v4-pro`. To switch providers, see [multi-provider config](/en/config/providers); to edit the config file directly, see [settings](/en/config/settings).

## Update

It's a global npm package, so updates go through npm too:

```bash
npm i -g @silassolivagus/deepcode@latest
```

or:

```bash
npm update -g @silassolivagus/deepcode
```

## Uninstall

```bash
npm uninstall -g @silassolivagus/deepcode
```

## Network proxy

If your machine needs a proxy to reach the API, deepcode automatically picks up the standard proxy environment variables — no extra config needed:

```bash
export https_proxy=http://127.0.0.1:7890
deepcode
```

## Next steps

- [Multi-provider config](/en/config/providers): switch between DeepSeek / GLM / Kimi / self-hosted backends.
- [Settings](/en/config/settings): settings fields for `~/.deepcode/settings.json`.
