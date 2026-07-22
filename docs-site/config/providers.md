---
title: 多 provider
---

# 多 provider

deepcode 内置三家国内厂商后端（DeepSeek / GLM·智谱 / Kimi·Moonshot），外加一个 OpenAI 兼容的 `custom` 档，可以接任意自建或第三方 OpenAI 兼容端点。四者共享同一套主循环、工具与权限体系——切后端只是换 key 和 baseURL，用法不变。

## 四类后端一览

| provider | env key | baseURL | smart（主循环） | fast（子操作） |
| --- | --- | --- | --- | --- |
| `deepseek`（默认） | `DEEPSEEK_API_KEY` | `https://api.deepseek.com` | `deepseek-v4-pro` | `deepseek-v4-flash` |
| `glm` | `ZHIPUAI_API_KEY` | `https://open.bigmodel.cn/api/paas/v4` | `glm-5.2` | `glm-5-turbo` |
| `kimi` | `MOONSHOT_API_KEY` | `https://api.moonshot.cn/v1` | `kimi-k2.7-code`（仅思考） | `kimi-k2.5` |
| `custom` | 自定义（缺省 `DEEPCODE_API_KEY`） | 自填 | 自填 | 自填 |

不设置 `provider` 时缺省即 `deepseek`。

## 配置方式

### 方式一：环境变量

最简单，装机即用，`apiKey` 只认对应厂商的 env：

```bash
export DEEPSEEK_API_KEY=sk-...
# 或
export ZHIPUAI_API_KEY=...
# 或
export MOONSHOT_API_KEY=...
```

### 方式二：`~/.deepcode/settings.json`

用 `provider` 选当前后端，`providers.{}` 存各家的 key（或自定义端点）。三份示例：

**切到 GLM：**

```jsonc
{
  "provider": "glm",
  "providers": {
    "glm": { "apiKey": "sk-..." }
  }
}
```

**切到 Kimi：**

```jsonc
{
  "provider": "kimi",
  "providers": {
    "kimi": { "apiKey": "sk-..." }
  }
}
```

**接自建 / 第三方 OpenAI 兼容端点（`custom`）：**

```jsonc
{
  "provider": "custom",
  "providers": {
    "custom": {
      "baseURL": "https://your-endpoint.example.com/v1",
      "apiKeyEnv": "MY_ENDPOINT_API_KEY", // 缺省 DEEPCODE_API_KEY
      "dialect": "openai",                // deepseek | glm | kimi | openai
      "models": { "fast": "your-fast-model", "smart": "your-smart-model" }
    }
  }
}
```

`custom.baseURL` + `custom.models.fast`/`models.smart` 是必填项，缺一个都会被判定为配置不全、静默回落 `deepseek`。`dialect` 只认 `deepseek`/`glm`/`kimi`/`openai` 四个值，其余会被丢弃。`providers` 与 `provider` 字段只在用户层（`~/.deepcode/settings.json`）生效，项目层配置会被剥离，避免协作仓库里的 settings 悄悄改你的 key 归属。

## 运行时切换：`/model`

交互 TUI 里输入 `/model` 打开选择器（也可以 `/model <名字>` 直接切），列表按当前 provider 的档在前、其它已配置 key 的 provider 档在后展示。

- 切同一 provider 内的档（比如 deepseek 内 fast/smart 互切）：立即生效，不重启。
- 切到另一个 provider（比如 deepseek 切 GLM）：需要重启一次进程，deepcode 会自动帮你完成——写设置、退出、带 `--resume` 重新拉起，当前会话历史原样恢复，只是换了底座。

目标 provider 没配 key 时选择器会标注「未配置」，选中会被拒绝，不会真的重启到一个打不通的后端。

## smart / fast 双档

每个 provider 都有两档：主循环规划、写代码、下决策用 **smart**；工具内部的子操作（比如子代理、摘要）用更便宜更快的 **fast**。默认组合见上面的总览表。

各家内置模型全貌（标「仅思考」的模型不能关闭 thinking，见下节）：

**DeepSeek**：`deepseek-v4-flash`、`deepseek-v4-pro`

**GLM**：`glm-5.2`、`glm-5.1`、`glm-5`、`glm-5-turbo`、`glm-4.7`、`glm-4.6`、`glm-4.5`、`glm-4.5-air`、`glm-4.6v`、`glm-4.6v-flash`

**Kimi**：`kimi-k3`（仅思考）、`kimi-k2.7-code`（仅思考）、`kimi-k2.7-code-highspeed`（仅思考）、`kimi-k2.6`、`kimi-k2.5`

## thinking 三态

thinking 默认 **`disabled`**（关），省 token、出手快；`/think` 开关切换，`/effort low|medium|high` 调思考力度。

有一类模型是「仅思考」——发 `thinking:{type:"disabled"}` 会被端点直接拒绝（比如上面标注的 Kimi 三个档）。deepcode 对这类模型做了守卫：关 thinking 时不发 `disabled` 字段，而是整体省略，让模型走它自己恒定的思考默认，不会因为想关思考反而把请求打崩。

## 定价

各厂定价见其官网。

---

下一步：[settings 与环境变量](/config/settings)。
