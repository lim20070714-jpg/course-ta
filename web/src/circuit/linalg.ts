/** 复数运算与稠密线性方程组求解（带部分主元的高斯消元）。 */

import { CircuitError } from './types'

export interface Cx {
  re: number
  im: number
}

export const cx = (re: number, im = 0): Cx => ({ re, im })

export const add = (x: Cx, y: Cx): Cx => ({ re: x.re + y.re, im: x.im + y.im })

export const sub = (x: Cx, y: Cx): Cx => ({ re: x.re - y.re, im: x.im - y.im })

export const neg = (x: Cx): Cx => ({ re: -x.re, im: -x.im })

export const mul = (x: Cx, y: Cx): Cx => ({
  re: x.re * y.re - x.im * y.im,
  im: x.re * y.im + x.im * y.re,
})

export const div = (x: Cx, y: Cx): Cx => {
  const d = y.re * y.re + y.im * y.im
  if (d === 0) throw new CircuitError('复数除法的分母为 0')
  return { re: (x.re * y.re + x.im * y.im) / d, im: (x.im * y.re - x.re * y.im) / d }
}

const mag = (x: Cx): number => Math.hypot(x.re, x.im)

const PIVOT_EPS = 1e-12

export function solveLinear(A: Cx[][], rhs: Cx[]): Cx[] {
  const n = rhs.length
  if (A.length !== n || A.some((row) => row.length !== n)) {
    throw new CircuitError('矩阵维度不一致')
  }
  const M: Cx[][] = A.map((row, i) => [...row, rhs[i]])

  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) {
      if (mag(M[r][col]) > mag(M[pivot][col])) pivot = r
    }
    if (mag(M[pivot][col]) < PIVOT_EPS) {
      throw new CircuitError('电路无法求解：存在悬空节点或理想电压源短路等奇异情况')
    }
    if (pivot !== col) {
      const tmp = M[col]
      M[col] = M[pivot]
      M[pivot] = tmp
    }
    const p = M[col][col]
    for (let r = col + 1; r < n; r++) {
      const f = div(M[r][col], p)
      if (f.re === 0 && f.im === 0) continue
      for (let c = col; c <= n; c++) {
        M[r][c] = sub(M[r][c], mul(f, M[col][c]))
      }
    }
  }

  const x: Cx[] = Array.from({ length: n }, () => cx(0))
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n]
    for (let c = r + 1; c < n; c++) {
      s = sub(s, mul(M[r][c], x[c]))
    }
    x[r] = div(s, M[r][r])
  }
  return x
}
