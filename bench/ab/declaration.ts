// 实验声明的解析与冻结。
//
// 声明刻意是纯数据（YAML）而非可执行代码：判定逻辑按名引用 predicates.ts 里有单测的实现。
// 若允许在声明里写闭包，尺子自己就可能带 bug，且两个实验无法直接 diff——更要命的是，
// 那等于允许「跑完再想一个新判定」，而那正是本项目要防的事。
import { createHash } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import { PREDICATES } from './predicates.js'

export interface Observation {
  id: string
  desc: string
  predicate: string
  args: Record<string, unknown>
  expect: boolean
}

export interface Declaration {
  id: string
  desc: string
  /** 臂名 → DEEPCODE_FLAGS 的取值。两臂跑同一份代码，唯一差异就是这个。 */
  arms: Record<string, Record<string, boolean>>
  /** 哪个臂是「实验臂」——p 值检验的方向。必须写死在声明里、跑前定死，不能等看完
   *  数据再选：看完数据再挑检验方向会让假阳性率翻倍，而防止这种自我欺骗正是本项目
   *  存在的理由。 */
  treatmentArm: string
  k: number
  task: { taskbook: string; frozen: string; harness: string }
  observations: Observation[]
}

export function parseDeclaration(yamlText: string): Declaration {
  const raw = parseYaml(yamlText)
  if (raw === null || typeof raw !== 'object') throw new Error('声明顶层必须是对象')

  const arms = raw.arms
  if (!arms || typeof arms !== 'object' || Object.keys(arms).length < 2) {
    throw new Error('arms 至少两个臂——A/B 实验没有对照就不成立')
  }
  if (Object.keys(arms).length > 2) {
    // 统计层（fisherOneTailed）是 2×2 精确检验，三个及以上的臂在数学上没法塞进同一张
    // 2×2 表里比。report.ts 的主判据表也只取 Object.keys(arms) 的前两个——多出来的臂
    // 会从主判据表里静默消失，只在次要指标/每次跑两张表里还能看到。与其让报告悄悄漏掉
    // 一个臂，不如在声明解析这一步就拒绝。
    throw new Error(`arms 最多两个臂——统计层是 2×2 Fisher 精确检验，多于两臂无法比较，收到：${Object.keys(arms).join(', ')}`)
  }
  for (const [armName, flags] of Object.entries(arms)) {
    if (!flags || typeof flags !== 'object') throw new Error(`臂 ${armName} 的取值必须是对象`)
    for (const [k, v] of Object.entries(flags as Record<string, unknown>)) {
      // flags.ts 只认真布尔，字符串 "true" 会被静默忽略退回默认值——那会让整轮实验
      // 的分组悄悄错位而不报错，必须在这里挡住。
      if (typeof v !== 'boolean') throw new Error(`臂 ${armName} 的 ${k} 必须是布尔，收到：${JSON.stringify(v)}`)
    }
  }

  // treatmentArm 决定 p 值检验的方向，必须跑前写死在声明里——不许按数据自动定方向
  // （那是统计学上错误的：看完数据再选方向会让假阳性率翻倍）。
  if (typeof raw.treatmentArm !== 'string' || raw.treatmentArm === '') {
    throw new Error(`treatmentArm 必须是非空字符串，收到：${JSON.stringify(raw.treatmentArm)}`)
  }
  if (!Object.prototype.hasOwnProperty.call(arms, raw.treatmentArm)) {
    throw new Error(`treatmentArm「${raw.treatmentArm}」不是 arms 里的臂——可选：${Object.keys(arms).join(', ')}`)
  }

  if (!Number.isInteger(raw.k) || raw.k <= 0) throw new Error(`k 必须是正整数，收到：${JSON.stringify(raw.k)}`)

  const obs = raw.observations
  if (!Array.isArray(obs) || obs.length === 0) throw new Error('observations 不能为空——它是主判据')
  const seen = new Set<string>()
  for (const o of obs) {
    if (!o?.id) throw new Error('每条 observation 都要有 id')
    if (seen.has(o.id)) throw new Error(`observation id 重复：${o.id}`)
    seen.add(o.id)
    if (!o.predicate) throw new Error(`observation ${o.id} 缺 predicate`)
    // 判定器名必须在注册表里——名字拼错（如 bashCommandsNoneMatchs）不该等真跑完
    // 10 次才在报告里现出一行不指名的「有 N 条观察求值为 null」。
    if (!(o.predicate in PREDICATES)) {
      throw new Error(
        `observation ${o.id} 的 predicate「${o.predicate}」不在判定器注册表里——` +
        `可选：${Object.keys(PREDICATES).join(', ')}`,
      )
    }
    if (typeof o.expect !== 'boolean') throw new Error(`observation ${o.id} 的 expect 必须是布尔`)
    // args 必须是普通对象——不能是字符串、null、数组、或缺失。
    // 若 args 是字符串，下游判定器访问 args.pattern 会得到 undefined，
    // 导致 String(undefined) 生成 "undefined" 正则，悄悄错掉整条观察。
    if (o.args === undefined || o.args === null || typeof o.args !== 'object' || Array.isArray(o.args)) {
      throw new Error(`observation ${o.id} 的 args 必须是对象，收到：${JSON.stringify(o.args)}`)
    }
  }

  // task 三个字段各自必须是非空字符串。falsy 检查会放行布尔/数字，导致错误
  // 直到下游 fs 调用才被发现。
  if (typeof raw.task?.taskbook !== 'string' || raw.task.taskbook === '') {
    throw new Error(`task.taskbook 必须是非空字符串，收到：${JSON.stringify(raw.task?.taskbook)}`)
  }
  if (typeof raw.task?.frozen !== 'string' || raw.task.frozen === '') {
    throw new Error(`task.frozen 必须是非空字符串，收到：${JSON.stringify(raw.task?.frozen)}`)
  }
  if (typeof raw.task?.harness !== 'string' || raw.task.harness === '') {
    throw new Error(`task.harness 必须是非空字符串，收到：${JSON.stringify(raw.task?.harness)}`)
  }

  return raw as Declaration
}

/** 对声明原文取 SHA256。跑前存档、跑完比对——证明判据没有在跑动中被改。 */
export function declarationHash(yamlText: string): string {
  return createHash('sha256').update(yamlText).digest('hex')
}
