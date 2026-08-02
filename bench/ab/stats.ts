// Fisher 精确检验（单尾）。
//
// 为什么用它而不是卡方：k=5 这种小样本下卡方的近似不成立。Fisher 是精确的，
// 小样本正是它的用武之地。
//
// 单尾而非双尾：我们问的是「实验臂是不是更好」这个有方向的问题，不是「两臂有没有差异」。

/** ln(n!) 用对数阶乘避免大数溢出；k=5 其实溢不了，但报告里可能出现更大的 k。 */
function lnFactorial(n: number): number {
  let s = 0
  for (let i = 2; i <= n; i++) s += Math.log(i)
  return s
}

/** 超几何分布：在固定四个边际的前提下，观察到左上角恰为 x 的概率。 */
function hypergeomProb(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d
  const lnP =
    lnFactorial(a + b) + lnFactorial(c + d) + lnFactorial(a + c) + lnFactorial(b + d) -
    lnFactorial(n) - lnFactorial(a) - lnFactorial(b) - lnFactorial(c) - lnFactorial(d)
  return Math.exp(lnP)
}

/** 2×2 表 [[a,b],[c,d]] 的单尾 p：检验「臂一命中率更高」。
 *  = 在边际固定下，左上角 ≥ a 的全部情形的概率之和。 */
export function fisherOneTailed(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d
  if (n === 0) return 1 // 无样本 → 无证据，p=1

  const rowA = a + b
  const colHit = a + c
  // 左上角的取值范围：不能超过所在行/列的边际，也不能让别的格变负
  const maxA = Math.min(rowA, colHit)

  let p = 0
  for (let x = a; x <= maxA; x++) {
    const xb = rowA - x
    const xc = colHit - x
    const xd = n - x - xb - xc
    if (xb < 0 || xc < 0 || xd < 0) continue
    p += hypergeomProb(x, xb, xc, xd)
  }
  // 浮点累加可能微溢出 1
  return Math.min(1, Math.max(0, p))
}
