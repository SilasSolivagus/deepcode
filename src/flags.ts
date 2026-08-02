// 实验性 prompt/机制条目的开关：命名 flag + 硬编码默认 + DEEPCODE_FLAGS JSON env 覆盖。
//
// 为什么需要它：A/B 实验的「一个臂」若定义成 git ref，两臂就是不同工作树、
// 构建产物不同——#6 的 R1/R4 正是栽在这个混淆项上（R1 跑编译包、R4 跑 tsx 源码）。
// 定义成环境变量组合后，两臂跑同一份代码同一个进程形态，唯一差异是这个 env，零混淆。
//
// 绝不抛出：本函数跑在 prompt 组装等热路径上，抛出会拖垮主流程。JSON 非法时
// 整体忽略并只警告一次（热路径上刷屏比不警告更糟）。

/** 非法 JSON 只警告一次的守卫。key 是那次的原始取值——env 换了新的坏值应当再警告一次。 */
let warnedFor: string | undefined

function parseFlags(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const o = JSON.parse(raw)
    // 顶层必须是对象；数组/字面量一律当没设
    if (o === null || typeof o !== 'object' || Array.isArray(o)) throw new Error('顶层不是对象')
    return o as Record<string, unknown>
  } catch (e) {
    if (warnedFor !== raw) {
      warnedFor = raw
      process.stderr.write(`⚠ DEEPCODE_FLAGS 解析失败，已整体忽略（全部 flag 走默认值）：${(e as Error).message}\n`)
    }
    return {}
  }
}

/** 求值一个命名 flag。env 里同名键为布尔时覆盖，否则用硬编码默认值。
 *  每次调用都重读 env——不缓存，好让测试与跑批器能在同进程内切换。 */
export function flag(name: string, defaultValue: boolean): boolean {
  const v = parseFlags(process.env.DEEPCODE_FLAGS)[name]
  // 只认真布尔：字符串 "true" / 数字 1 一律不做真值转换，退回默认值。
  // 实验参数写成字符串却被当成开启，会让整轮实验的分组悄悄错位。
  return typeof v === 'boolean' ? v : defaultValue
}
