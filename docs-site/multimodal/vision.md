---
title: 图片视觉
---
# 图片视觉

把截图丢给它看——报错截图、设计稿、图表。图片会**就地拼进当前这轮消息**，不是先转成一段文字
描述再喂进去。

## 哪些模型支持

| provider | 支持视觉的模型 |
|---|---|
| GLM | `glm-4.6v`、`glm-4.6v-flash` |
| Kimi | `kimi-k2.7-code`、`kimi-k2.7-code-highspeed`、`kimi-k2.6`、`kimi-k2.5` |

用 `/model` 切到其中之一即可。

## 图片怎么进上下文

带图片的 user 消息在拼线时被展开成 OpenAI 的内容块格式——**文本块在前，`image_url` 块随后**，
图片以 `data:` base64 内联。

::: warning 不支持视觉的模型下图片会被丢掉
拼线只在 `supportsVision` 为真时展开图片。切到不支持视觉的模型，图片旁挂不会被拼进请求——
**它看不到你贴的图**。想让它看图，先 `/model` 切到上表里的模型。
:::

## 与文档解析的区别

| | 视觉 | [文档解析](/multimodal/documents) |
|---|---|---|
| 走什么 | 当前模型的视觉能力 | GLM-OCR，**与当前 provider 解耦** |
| 适合 | 截图、图表、界面 | PDF、扫描件、有版式的长文档 |
| 输出 | 模型直接"看"图作答 | 先转成 markdown，再当文本处理 |

一张报错截图用视觉；一份 40 页 PDF 用文档解析——**后者转成 markdown 之后是可检索、可引用的
文本**，视觉模型盯着 40 页图片既贵又容易漏。

---

相关：[文档解析](/multimodal/documents) · [多 provider](/config/providers)
