# 安全策略

## 报告漏洞

**请不要开公开 issue。** 两个私下渠道任选：

- GitHub [私密漏洞报告](https://github.com/SilasSolivagus/deepcode/security/advisories/new)（推荐）
- 邮件 dirctable@gmail.com

请尽量带上：受影响的版本（`deepcode --version`）、复现步骤、你认为的影响面。

我会在 **72 小时内**回复确认收到。修复时间取决于严重程度，修好后会在
[CHANGELOG](CHANGELOG.md) 里致谢报告者（除非你希望匿名）。

## 支持的版本

只有最新的 minor 版本会收到安全修复。请保持更新：

```bash
npm i -g @silassolivagus/deepcode@latest
```

## 这个工具本身的风险面

deepcode 是一个会**在你的机器上执行命令、读写你的文件、访问网络**的 agent。
下面几条是设计上的已知风险，不是漏洞，但你应当知道：

- **`--yolo` 跳过全部权限询问。** 只在你信任任务内容、且在隔离环境里用。
- **`--trace` / `DEEPCODE_TRACE_DIR` 落盘的是发给模型的完整上下文**，其中包含 agent
  读过的所有文件原文，**可能含密钥与私有代码**。目录以 `0700` 创建，但它是本地诊断工具，
  不是日志——不要在共享环境常开，用完请自行删除。
- **工具结果是不可信输入。** agent 从文件、网页、子进程读到的内容可能包含试图操纵它的文本。
  deepcode 在设计上不把这些内容当指令，但没有任何 agent 能对提示注入完全免疫——
  对来源不明的代码库和网页保持警惕。
- **API key 存在 `~/.deepcode/settings.json`**，文件权限 `600`。

如果你发现的是上述**已知风险之外**的问题——比如权限检查能被绕过、SSRF 防护失效、
密钥出现在不该出现的地方——那就是漏洞，请按上面的渠道报告。
