# 参与 deepcode

项目还年轻，**现在提的每一条 issue 都会被认真对待**。不用客气，也不用先问「可以提吗」。

## 最有用的三件事

**① 报告一个真实场景下的失败。** 比「建议增加 X」有用得多。带上：

```bash
deepcode --version
```

加上你敲了什么、期望什么、实际得到什么。**能复现的 bug 报告是这个项目最稀缺的东西。**

**② 说说你在用什么模型、什么场景。** deepcode 是围绕 DeepSeek / GLM / Kimi 的实际行为调的，
你用的 provider 和任务类型直接决定下一步该调哪里。这类信息在
[Discussions](https://github.com/SilasSolivagus/deepcode/discussions) 里说就行。

**③ 改代码。** 见下。

## 上手

```bash
git clone https://github.com/SilasSolivagus/deepcode && cd deepcode
npm i
npm test           # vitest，全套约 3000 条
npm run typecheck  # tsc --noEmit
npm start          # 跑本地源码（需要至少一个 provider 的 key）
```

Node ≥ 22.5。仓库是 TypeScript / ESM。

## 提 PR 之前

**必须过的三关：**

```bash
npm run typecheck   # 必须干净
npm test            # 必须全绿
npm run build       # 必须通过
```

**代码约定：**

- **跟着周围的代码写。** 命名、注释密度、惯用法都以你改的那个文件为准，不要顺手「改进」邻近代码。
- **注释写「为什么」，不写「是什么」。** 这个仓库的注释密度偏高是刻意的——尤其是那些
  「这里看起来可以简化，但不能，因为……」的地方，它们挡住过真实的回归。
- **新行为要有测试。** 不接受只加实现不加测试的 PR。
- **测试要有区分度。** 一条永远为真的断言比没有测试更糟——它会让人以为这里被守住了。
  拿不准的时候，把实现改坏一行，看测试挂不挂。

**提交信息用中文**，一行说清做了什么、必要时空行后说为什么。

## 设计原则

改动如果和下面几条冲突，先在 issue 里聊聊：

- **控制流姓代码、智能姓模型**：能用确定性代码决定的事，不要交给模型判断。
- **重试只包 API 建流**，工具执行不重放——重放副作用比失败更糟。
- **报错写给模型看**：错误消息的第一读者是 agent 自己，要能据此改正。
- **工具结果是不可信输入**：来自文件、网络、子进程的内容一律不当指令。

## 报安全问题

**不要开公开 issue**，见 [SECURITY.md](SECURITY.md)。

## 许可

提交即表示你同意你的贡献以 [MIT](LICENSE) 发布。
