---
title: Skills
---

# Skills

## Skills 是什么

Skill 是一份打包好的指令集：一个目录，目录里放一个 `SKILL.md`，把一段可复用的操作流程、专项知识或固定套路固化下来，让模型在合适的场景下直接照着执行，不用每次在对话里重新描述一遍。一个 skill 由两部分组成：frontmatter（YAML 元数据，描述这个 skill 是什么、什么时候用、怎么执行）+ 正文（真正下发给模型的指令文本）。

Skill 有两种触发方式：模型根据 frontmatter 里的 description 自己判断当前场景是否适用、主动调用；也可以由你直接手动触发某个 skill，跳过模型判断。

## 源目录

deepcode 从两个目录发现 skill：

- 全局：`~/.deepcode/skills/`——对所有项目生效
- 项目：`<项目根目录>/.deepcode/skills/`——只在当前项目生效，且优先级高于全局（同名 skill 时项目目录里的定义覆盖全局的）

每个 skill 是该目录下的一个子目录，子目录里放一个 `SKILL.md` 文件。此外，deepcode 也兼容通用第三方技能目录。

## 写一个 skill

`SKILL.md` 由 frontmatter 和正文组成，frontmatter 字段都可省略，缺省有兜底行为：

- `name`：skill 名称；缺省用目录名。
- `description`：给模型看的功能描述，决定了模型能否自动发现并调用这个 skill；缺省取正文第一个非空行。
- `when-to-use`：追加的"什么时候用"说明，随 description 一起出现在清单里。
- `context`：`inline`（默认）或 `fork`。`inline` 把正文作为一条用户消息注入当前对话，由主模型直接执行；`fork` 会另起一个子代理执行正文指令，与当前对话隔离。
- `agent`：`context: fork` 时，指定用哪个 agent 类型跑子代理；不填缺省 `general-purpose`。
- `allowed-tools`：`context: fork` 时，收窄子代理能用的工具列表（逗号分隔或数组）。
- `model`：`context: fork` 时，子代理用的模型（可用能力档别名，也可写具体模型 id）。
- `user-invocable`：是否允许直接手动触发这个 skill；默认 `true`。
- `disable-model-invocation`：设为 `true` 后，模型不会自动发现/调用这个 skill，只能被手动触发；默认 `false`。
- `arguments`：具名参数列表（逗号分隔或数组），配合正文里的具名占位符使用。

正文里可以用下面这些变量做参数替换：

- `$ARGUMENTS`：调用时传入的完整参数字符串
- `$ARG1`、`$ARG2`……：参数按空白切分后的第 N 段
- `$<name>`：`arguments` 里声明的具名参数，按声明顺序对应位置
- `${DEEPCODE_SKILL_DIR}`：这个 skill 所在目录的绝对路径
- `${DEEPCODE_SESSION_ID}`：当前会话 id

一个最小示例（`~/.deepcode/skills/translate/SKILL.md`）：

```markdown
---
name: translate
description: 把一段文本翻译成指定语言
arguments: text, lang
---

把下面这段文本翻译成 $lang，只给译文，不要多余说明：

$text
```

## 触发

模型可调用的 skill（没设 `disable-model-invocation: true`、也没被收窄成不可模型调用）会出现在内置 Skill 工具的清单里，模型据此判断当前需求是否匹配某个 description，匹配就主动调用；你也可以直接告诉模型去用某个 skill，模型据此显式调用。

`user-invocable` 的 skill（默认所有 skill 都是）还可以在输入框里直接敲 `/技能名 参数` 触发，跳过模型判断，参数会原样替换进正文再执行。

## 收窄

`settings.json` 里的 `skills` 字段控制扫描范围：

- `skills.sources`：限定扫描哪些目录家族，缺省两者都扫；只填原生家族可以跳过兼容目录，只扫 `.deepcode/skills`。
- `skills.deny`：按精确名称排除某些 skill，被排除的 skill 完全不加载，既不出现在清单里也不能被调用。
- `skills.listingBudgetChars`：Skill 工具清单里所有 skill 的 description/`when-to-use` 总字符预算，缺省 8000。

`skillOverrides` 是按 skill 名的四态开关，语义是**只收紧、不放松**——即使把某个 skill 的 override 设成更松的状态，也不会覆盖它自身 frontmatter 里更严格的设定（比如一个本身设了 `disable-model-invocation: true` 的 skill，override 成 `on` 也不会让它变成模型可调用）：

| 状态 | 效果 |
| --- | --- |
| `on` | 保持 frontmatter 原有设定（缺省状态） |
| `name-only` | 清单里只出现名字，不带 description/`when-to-use` |
| `user-invocable-only` | 模型不可自动调用，只能手动触发 |
| `off` | 完全禁用，模型和手动触发都不能用 |

清单渲染时，每条 skill 的 description/`when-to-use` 会先各自截断，若全部加起来仍超过总字符预算，会从优先级最低的一端开始整条丢弃，并在清单末尾留一行提示，指引你用 `deny`/`sources` 收窄或写更短的 description。

---

`skills`、`skillOverrides` 等字段的完整说明、分层与剥离规则见 [settings](/config/settings)；内置工具全貌见 [工具总览](/tools/overview)。
