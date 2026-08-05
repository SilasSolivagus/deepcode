---
title: 跑分与可复现评测
---
# 跑分与可复现评测

deepcode 跑两套评测：一套是行业标准题集（**SWE-bench Verified**，量 harness 的绝对水平），
一套是自建的可靠性评测（量同一件事重复做几次能不能都做对）。两套都可复现。

## SWE-bench Verified

行业标准题集，**官方 Docker 判分、跑隐藏测试**——不是自己给自己打分。

模型固定为 `deepseek-v4-pro`，100 题 × 3 seed：

| 指标 | 值 |
|---|---|
| pass@1（3 个 seed 平均） | **62.7%**（188/300） |
| pass^3（3 个 seed 全中，可靠性） | **52/100** |
| 至少中一次 | 71/100 |

同题、同模型、同判分下，与一个商业 harness **统计打平**：25 道有差异的题里各赢一半，
双尾符号检验 p=1.0。**不宣称胜负**——这是个有统计分量的平局。

### 为什么信 100 题而不信 23 题

| 样本 | deepcode | 对照 | 差 |
|---|---|---|---|
| 23 题 | 43.5% | 42.0% | +1.5（噪声） |
| 100 题 | **62.7%** | **62.3%** | **+0.4（打平）** |

小样本上的「领先」是抽样噪声，样本一大就回归平局。**这正是不该拿小样本宣称胜负的理由**——
如果当初只跑 23 题就发结论，会得出一个后来被自己推翻的说法。

### 抽样与判分口径

- 100 题：种子 42 固定、代表性抽样、排除 django、排除预计 >4h 的题。
- 超时项（23 个）用 1800s 重跑后并入。
- 补丁抽取规则统一：`git diff base_commit`，**剔除该题 `test_patch` 涉及的测试文件**——
  防止「改测试让它过」。
- 判分在 x86_64 Linux 原生 Docker 上跑，不用 arm 模拟。

### 公平性锚点

测的是 **harness（脚手架）**，不是模型。受控变量全部摆在明面上：

| 项 | 值 |
|---|---|
| 模型与端点 | 两边打完全相同的 base URL + 模型 ID |
| temperature | 都不发，让模型用默认 |
| 题集 | 同一份子集 |
| 任务输入 | 同一段 problem_statement + 同一「只改非测试源码」的框架 prompt |
| 补丁抽取 | 同一规则（见上） |
| 判分 | SWE-bench 官方 Docker，隐藏测试 FAIL_TO_PASS + PASS_TO_PASS |
| seed 数 | 每格相同 |

**被测的差异就是 harness 本身**：导航策略、编辑格式、验证与自检、上下文管理、工具集、子代理委派。

### 诚实边界

::: warning 两条必须说明白的局限
1. **SWE-bench Verified 是公开集，可能已被训练污染。** 要挤掉这部分水分，得加跑未污染集
   （如 SWE-bench Pro）。这一条对参与对比的双方同等成立，但会让绝对数字偏高。
2. **生成机器未受控**：两边在同一台本机跑，但运行时形态不同。这不影响模型产出的补丁，只影响
   墙钟耗时——所以**耗时只供参考，不作结论**。
:::

### 自己跑一遍

方法、脚本与原始数据（判分矩阵 + preds 补丁）全部公开在
[deepcode-arena](https://github.com/SilasSolivagus/deepcode-arena)：clone 下来，填 key，
一条命令复现。

## 自建可靠性评测

SWE-bench 量的是「能不能做对」，这套量的是「**重复做几次能不能都做对**」。

防污染自建场景 × 5 模型 × 3 seed 的 **pass^3**（三次全中才算过），程序化判分不靠主观。
`deepseek-v4-pro` / `glm-5.2` / `kimi-k3` 均跑满 5/5 场景。

### 为什么用 pass^N 而不是 pass@1

单跑一次全过、跑三次只过一次的模型，用 pass@1 看不出来。实测里 `deepseek-flash` 在最难的
求值器场景上只有 1/3——**单跑会误判 OK，多 seed 才照出不可靠**。对要放进自动化流水线的工具来说，
可靠性比峰值能力更重要。

```bash
node eval/run.mjs --models deepseek-v4-pro,deepseek-v4-flash,glm-5-turbo,glm-5.2 --seeds 3
```

完整报告见仓库里的
[`eval/RESULTS-2026-07-17.md`](https://github.com/SilasSolivagus/deepcode/blob/main/eval/RESULTS-2026-07-17.md)，
成本-可靠性 Pareto 图见[官网跑分节](https://deepcode.dirctable.com/#bench)。

## 还没做的

- 未污染集（SWE-bench Pro）——挤掉公开集可能的训练污染
- `kimi-k3` 上的完整对比
- 扩到 SWE-bench Verified 全量 500 题
