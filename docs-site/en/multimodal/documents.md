---
title: PDF / documents
---
# PDF / documents

PDFs and images can be converted to markdown before entering the context — **once converted it's
ordinary text**: searchable, quotable, compressible, and it doesn't run up a vision model's bill.

## Decoupled from the active provider

Document parsing goes through **GLM-OCR**, independently of the model you're working with:

```
Working on DeepSeek + a GLM key configured ⟶ PDFs still parse
```

What it needs is a GLM key (env `ZHIPUAI_API_KEY`, or `providers.glm.apiKey` in settings). It does
**not** require switching your active provider to GLM. Without a GLM key it reports a missing key
explicitly rather than failing silently.

## Output

You get markdown plus a page count. The converted content enters the context as ordinary text —
**you can have it Grep the document, quote a specific section, cross-reference another file**, none
of which is possible when a PDF is treated as a picture.

## Timeouts and errors

| Situation | What you see |
|---|---|
| Over 180 seconds | "document parsing timed out" |
| Non-2xx from the server | "document parsing failed: HTTP `<status>`" |
| Unexpected response shape | "document parsing failed: no md_results in response" |

All three are explicit errors — **you never get an empty document that looks like a successful
parse**.

It honours `https_proxy` / `HTTPS_PROXY` / `http_proxy` / `HTTP_PROXY` when a proxy is needed.

## Which one to use

- **Screenshots, charts, UI problems** → [Image vision](/en/multimodal/vision), let the model look
- **PDFs, scans, long documents with layout** → document parsing, convert to markdown

The deciding question is **whether you'll want to do text operations on it afterwards**. If you
need to search, quote, or cross-reference, convert to markdown first.

---

Related: [Image vision](/en/multimodal/vision) · [Providers](/en/config/providers)
