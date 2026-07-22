---
title: 安装与更新
---

# 安装与更新

## 安装

Node ≥ 22.5：

```bash
npm i -g @silassolivagus/deepcode
```

## 首跑

直接跑 `deepcode`，首次运行会弹出向导，粘贴 key 即可（写入 `~/.deepcode/settings.json`，权限 600）：

```bash
deepcode
```

已有 key 也可以跳过向导，直接用环境变量：

```bash
export DEEPSEEK_API_KEY=sk-...
deepcode
```

默认模型是 `deepseek-v4-pro`。想切 provider，见 [多 provider 配置](/config/providers)；想直接改配置文件，见 [settings](/config/settings)。

## 更新

装的是全局包，更新同样用 npm：

```bash
npm i -g @silassolivagus/deepcode@latest
```

或者：

```bash
npm update -g @silassolivagus/deepcode
```

## 卸载

```bash
npm uninstall -g @silassolivagus/deepcode
```

## 网络代理

如果本机需要走代理才能连上 API，deepcode 会自动读取标准代理环境变量，无需额外配置：

```bash
export https_proxy=http://127.0.0.1:7890
deepcode
```

## 下一步

- [多 provider 配置](/config/providers)：切 DeepSeek / GLM / Kimi / 自建后端。
- [settings](/config/settings)：`~/.deepcode/settings.json` 的字段说明。
