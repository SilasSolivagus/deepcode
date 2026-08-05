---
title: Image vision
---
# Image vision

Hand it a screenshot — an error, a design mock, a chart. The image is spliced **directly into the
current turn**, not converted to a text description first.

## Which models support it

| Provider | Vision-capable models |
|---|---|
| GLM | `glm-4.6v`, `glm-4.6v-flash` |
| Kimi | `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, `kimi-k2.6`, `kimi-k2.5` |

Switch with `/model`.

## How images enter the context

A user message carrying images is expanded at wire time into OpenAI content blocks — **text block
first, then `image_url` blocks**, with the image inlined as a `data:` base64 URL.

::: warning Images are dropped on non-vision models
The expansion only happens when `supportsVision` is true. Switch to a model without vision and the
attached images are never spliced into the request — **it cannot see what you pasted**. Use
`/model` to switch to one of the models above first.
:::

## Vision vs document parsing

| | Vision | [Document parsing](/en/multimodal/documents) |
|---|---|---|
| Path | The current model's vision capability | GLM-OCR, **decoupled from the active provider** |
| Good for | Screenshots, charts, UI | PDFs, scans, long documents with layout |
| Output | The model looks at the image directly | Converted to markdown, then handled as text |

An error screenshot: vision. A 40-page PDF: document parsing — **once it's markdown it's
searchable, quotable text**, whereas pointing a vision model at 40 pages of images is both
expensive and easy to skim past.

---

Related: [Document parsing](/en/multimodal/documents) · [Providers](/en/config/providers)
