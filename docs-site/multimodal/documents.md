---
title: PDF / 文档输入
---
# PDF / 文档输入

PDF 与图片可以先转成 markdown 再进上下文——**转完之后就是普通文本**，能检索、能引用、能被
压缩，不占视觉模型的账。

## 与当前 provider 解耦

文档解析走 **GLM-OCR**，独立于你正在用的模型：

```
用 DeepSeek 干活 + 配一个 GLM key ⟶ 照样能解析 PDF
```

它需要的是 GLM 的 key（环境变量 `ZHIPUAI_API_KEY`，或 settings 里的
`providers.glm.apiKey`），**不要求你把 active provider 切到 GLM**。没有 GLM key 时会明确报
「缺少 key」，不会静默失败。

## 输出

返回 markdown，附带页数。转换后的内容当作普通文本进入上下文——**你可以让它 Grep、可以让它
引用某一段、可以让它对照另一份文件**，这些在「把 PDF 当图片看」的模式下都做不到。

## 超时与错误

| 情况 | 表现 |
|---|---|
| 超过 180 秒 | 报「文档解析超时」 |
| 服务端非 2xx | 报「文档解析失败：HTTP `<状态码>`」 |
| 响应结构不对 | 报「文档解析失败：响应无 md_results」 |

三种都是明确报错，**不会返回一份空文档让你以为解析成功了**。

需要代理时它会读 `https_proxy` / `HTTPS_PROXY` / `http_proxy` / `HTTP_PROXY`。

## 什么时候用哪个

- **截图、图表、界面问题** → [图片视觉](/multimodal/vision)，让模型直接看
- **PDF、扫描件、有版式的长文档** → 文档解析，转成 markdown

判据是**你之后要不要对内容做文本操作**。要检索、要引用、要跨文件对照，就先转 markdown。

---

相关：[图片视觉](/multimodal/vision) · [多 provider](/config/providers)
