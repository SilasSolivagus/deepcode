import { describe, it, expect } from 'vitest'
import { parseDeclaration, declarationHash } from '../bench/ab/declaration.js'

const VALID = `
id: exp-1
desc: 测试用
arms:
  baseline: {}
  treatment: { verifyMethod: true }
k: 5
task:
  taskbook: ./TASKBOOK.md
  frozen: ./FROZEN.txt
  harness: ./harness
observations:
  - id: o1
    desc: 观察一
    predicate: bashCommandsNoneMatch
    args: { pattern: 'x' }
    expect: true
`

describe('parseDeclaration', () => {
  it('合法声明正常解析', () => {
    const d = parseDeclaration(VALID)
    expect(d.id).toBe('exp-1')
    expect(d.k).toBe(5)
    expect(Object.keys(d.arms)).toEqual(['baseline', 'treatment'])
    expect(d.arms.treatment).toEqual({ verifyMethod: true })
    expect(d.observations).toHaveLength(1)
    expect(d.observations[0].predicate).toBe('bashCommandsNoneMatch')
  })

  it('少于两个臂 → 报错（A/B 至少要两臂）', () => {
    expect(() => parseDeclaration(VALID.replace('  treatment: { verifyMethod: true }\n', '')))
      .toThrow(/至少两个臂/)
  })

  it('k 非正整数 → 报错', () => {
    expect(() => parseDeclaration(VALID.replace('k: 5', 'k: 0'))).toThrow(/k/)
    expect(() => parseDeclaration(VALID.replace('k: 5', 'k: 2.5'))).toThrow(/k/)
  })

  it('observations 为空 → 报错（主判据不能没有）', () => {
    const noObs = VALID.slice(0, VALID.indexOf('observations:')) + 'observations: []\n'
    expect(() => parseDeclaration(noObs)).toThrow(/observations/)
  })

  it('观察项 id 重复 → 报错（报告里会串）', () => {
    const dup = VALID + `  - id: o1
    desc: 重复的
    predicate: bashCommandsAnyMatch
    args: { pattern: 'y' }
    expect: true
`
    expect(() => parseDeclaration(dup)).toThrow(/重复/)
  })

  it('臂的取值含非布尔 → 报错（flag 只认真布尔，字符串会被静默忽略导致分组错位）', () => {
    expect(() => parseDeclaration(VALID.replace('{ verifyMethod: true }', '{ verifyMethod: "true" }')))
      .toThrow(/布尔/)
  })

  it('YAML 语法错 → 报错', () => {
    expect(() => parseDeclaration('id: [unclosed')).toThrow()
  })
})

describe('declarationHash', () => {
  it('同样内容给同样哈希', () => {
    expect(declarationHash(VALID)).toBe(declarationHash(VALID))
  })
  it('差一个字符就换哈希', () => {
    expect(declarationHash(VALID)).not.toBe(declarationHash(VALID + ' '))
  })
  it('是 64 位十六进制', () => {
    expect(declarationHash(VALID)).toMatch(/^[0-9a-f]{64}$/)
  })
})
