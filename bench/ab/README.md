# bench/ab —— A/B 实验跑批器

判断 prompt / 机制层改动到底有没有用。

## 用法

    npx tsx bench/ab/run.ts bench/ab/experiments/<实验>.yaml [--concurrency 3] [--timeout 1800] [--out DIR]

## 一个实验 = 一个声明文件（纯数据）

见 `experiments/verify-method.yaml`。四样东西写死在里面：两臂的 `DEEPCODE_FLAGS` 取值、
每臂跑几次、任务书与冻结测试集的位置、以及**行为观察**。

跑前对声明取 SHA256、跑完再比一次——判据在跑动中被改，报告直接作废。

## 为什么观察项要跑前冻结

#6 dogfooding 评测里，改完 prompt 重跑的总分从 12/46 涨到 42/46。只看这个数字会宣布
改动有效并发版。但开跑前定死的三条行为观察显示：三项里两项纹丝不动、一项更差——涨分
全部由「这一批恰好没生成某个 bug」解释。

**挡住误判的不是分数，是开跑前就写死的观察。** 允许跑完再挑指标，跟事后找解释没区别。

## 为什么声明是纯数据而不是可执行代码

判定逻辑按名引用 `predicates.ts` 里有单测的实现。若允许在声明里写闭包，尺子自己就可能
带 bug，两个实验也无法直接 diff。代价是判定器不够用时得改代码加一个——这是刻意付的：
能临时写，就等于允许「跑完再想个新判定」。

新增判定器的门槛：**必须有单测**，且要在设计文档 §4 的表里登记。

## 判定器一览

| 名字 | 判什么 | 何时返回 null（从分母排除） |
|---|---|---|
| `bashCommandsAnyMatch` / `bashCommandsNoneMatch` | Bash 命令原文是否匹配正则 | 不返回 |
| `numericFromBashAtLeast` | 从命令里抽捕获组数字，最大值是否 ≥ min | 不返回 |
| `statusIs` | 终止状态是否等于给定值 | 不返回 |
| `fileExists` | 产出物目录下某相对路径是否存在 | 不返回 |
| `editedFileCountAtLeast` | 去重后改动文件数 ≥ min | 不返回 |
| `spawnedWhenEditsAtLeast` | 改动数够阈值时是否派过该类型子代理 | 改动数没够阈值 |
| `verdictSeen` | 是否出现过某个 verdict | 不返回 |
| `editAfterVerdict` | 某 verdict 之后是否还改过文件 | 全程没出现该 verdict |
| `verdictWithoutEvidence` | 是否存在「PASS 但报告里没有命令与输出」 | 全程没有 PASS |
| `finishedWithFailingCommand` | 最后一条失败命令之后没再改文件却正常收工 | `status !== 'done'` |
| `subagentFinishedWithFailingCommand` | （可选按 `subagentType` 收窄后）任一子代理在最后一条失败命令之后再没跑出成功的命令 | 无（该类型）子代理记录 |
| `subagentRanNoCommand` | （可选按 `subagentType` 收窄后）任一子代理的最后一次 spawn 一条 Bash 命令都没跑 | 无（该类型）子代理记录 |
| `frozenBuilt` | 交付物装依赖并构建成功 | 未跑考卷 |
| `frozenAllPass` | 冻结考卷全过（构建失败或没跑成记 false，不是 null） | 未跑考卷 |
| `frozenPassAtLeast` | 冻结考卷通过数 ≥ `min` | 未跑考卷 |

⚠️ **`finishedWithFailingCommand` 只覆盖主代理直接执行的命令，子代理内部的执行不进轨迹**
（子代理跑的是另一个 `runLoop`，其事件从不经 `streamFromLoopEvent` 落盘）。派子代理去干
验证/测试工作的臂，在这条上会被系统性低估失败数——不是它更可靠，是轨迹看不见。用它做
跨臂对比前先确认两臂的验证工作都发生在主代理轨迹内。

⚠️ **`subagentFinishedWithFailingCommand` / `subagentRanNoCommand` 必须传 `subagentType` 收窄**：
Explore/Plan/general-purpose 也带 Bash（`agentTypes.ts` 只禁 Edit/Write/Agent/NotebookEdit），
系统提示词还鼓励并行派只读子代理去探索。不收窄时两个判定器对全部 label 取或，实验臂的
label 集合天然是对照臂的超集（多一个 verification），子代理越多越容易被判定器命中——
系统性偏置实验臂，两臂量的根本不是同一个东西（终审实证：对照臂只派了一个带红收工的
`Explore`、压根没有任何验证行为，取或后仍判定为「带红收工」）。

⚠️ **两者读的都是从请求侧轨迹恢复的子代理执行记录，属事后重建**：轨迹记的是「发出去
之前」的对话。`src/loop.ts` 的主循环在工具结果 push 进 `messages` 之后一律进下一轮再发
一次请求，只有模型本轮不再调工具时子代理才结束——所以**正常终止路径下最后一批结果
一定会进下一次请求，不会漏**。真正会漏的只有子代理**非正常终止**：撞 `maxTurns`（子代理
是 30）、被中断、抛异常，这些情况下最后一批命令没有再触发一次请求，读不到。**已知伪影
单列**：验证者烧完 30 轮被截断时，轨迹里可见的最后一条很可能是绿的，会被读成「没带红
收工」，白送一次命中——这恰恰是最危险的场景，量交付质量的观察最该抓住它却抓不住。
同一类子代理若被多次 spawn（先红后修绿），每次 spawn 的完整标签各自唯一
（`subagent:<type>#<agentId>`，见 `src/subagentRunner.ts`），判定器按 label 分组后
只看该 label 数组顺序里的最后一条（即 seq 最大、最近发生的那次 spawn）。

`null` 表示**本次跑不适用于这条观察**，与求值失败同样从统计分母里排除。
不用 `true` 代替是刻意的：空真会让命中率被一堆无信息的跑灌水，看着好看却什么都没证明。

## 唯一的跨臂质量判据：冻结考卷

`frozen-built` 与 `frozen-all-pass` 是**仅有的两条能做跨臂对比的质量观察**。它们不看跑的过程，
只看交付物：两臂都产出一份东西，用同一套**跑前就冻结好的**考卷考，因此两臂都有分母、可出 p 值。

**为什么其余观察做不到**：从轨迹里推质量这条路走不通——被测机制会改变轨迹的形状。这条线上栽过两次：
原来那条只看主代理命令的观察，被「把测试搬进子代理」白送命中；补了子代理侧之后，验证者在对照臂
结构上根本不存在，分母恒为 0。**所以那些观察是实验臂的机制体检，不是质量证据，不能拿 p 值做跨臂宣称。**

⚠️ **`npm install` 联网失败会被记成质量失败，与「模型没做出来」不可区分。** 看到 `frozen-built`
大面积为假时，先查各次跑目录下的 `frozen-notes.txt` 里的诊断原文，别直接下结论。

## ⚠️ 观察项要分清「机制」与「质量」

`contract-followed` 与 `loop-closed` 这类观察在对照臂上必然为假或不适用（对照臂根本没有那套机制）。
它们能证明机制按设计跑起来了，**不能证明交付物更可靠**。拿它们的 p 值宣称「改动有效」是错的。

一份实验里至少要有一条量交付质量的观察，否则它回答不了「可靠性有没有提高」。
`verification-agent` 这份实验现在有了 `subagent-no-red-at-finish` / `subagent-ran-commands`
这样两条观察（原有的 `no-red-at-finish` 因 `finishedWithFailingCommand` 在子代理执行不进
轨迹的前提下会被系统性偏置而删除，见该声明文件里的注释；后来通过从请求侧轨迹恢复子代理
执行记录的方式弥补了这个盲区）。

⚠️ **但这两条观察在跨臂对比的意义上不成立**：`src/agentsLoader.ts` 在 `verificationAgent`
flag 关时把 `verification` 从注册表里滤掉，所以对照臂结构上永远派不出验证者——加了
`subagentType` 收窄之后，**对照臂在这两条观察上的分母恒为 0**（报告会印出「—（对照臂无
有效样本）」而不是静默产出一个看似正常的百分比）。它们是**实验臂的单臂体检**——回答
「验证者是否真的把红修绿了 / 是否真的跑了命令」，**不是**能出 p 值的跨臂质量对比，不能
拿它们的 p 值宣称「改动有效」。

## 局限

- 只测得到 headless 覆盖的东西。只在 TUI 可达的路径（如 auto 模式权限分类器）测不到。
- 单任务。结论不外推。
- k=5 对中等效应（5/5 vs 3/5，p≈0.22（单尾））判不出来。遇到这种结果，正确结论是「效应弱或
  需要更大 k」，不是「无效」。
- 成本：单跑约 ¥0.28 / 半小时；k=5 两臂共 10 次跑约 ¥2.8、并发 3 时约一小时。
