/**
 * 改名前的本地校验，规则与后端保持一致（server/app/api/courses.py），
 * 这样用户立刻知道为什么不行，而不是等一次请求。
 */
import { MATERIAL_ACCEPT } from '../api'

export const MAX_COURSE_NAME = 60
export const MAX_MATERIAL_NAME = 120

export interface NameCheck {
  ok: boolean
  value: string // 收拾过的名字（去首尾空格、剥掉目录成分）
  message: string // ok 为 false 时给用户的说法
}

/** Windows 与常见文件系统不允许的字符；'/' 与 '\\' 会被 basename 当目录吃掉。 */
const ILLEGAL = '<>:"|?*'

const SUPPORTED_SUFFIXES = MATERIAL_ACCEPT.split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

export function basename(raw: string): string {
  const parts = raw.trim().split(/[/\\]/)
  return parts[parts.length - 1] ?? ''
}

export function checkCourseName(raw: string): NameCheck {
  const value = raw.trim()
  if (!value) return { ok: false, value, message: '课程名不能为空' }
  if (value.length > MAX_COURSE_NAME)
    return { ok: false, value, message: `课程名最长 ${MAX_COURSE_NAME} 个字` }
  return { ok: true, value, message: '' }
}

export function checkMaterialName(raw: string): NameCheck {
  const value = basename(raw)
  if (!value || value === '.' || value === '..')
    return { ok: false, value, message: '资料名不能为空' }
  if (value.length > MAX_MATERIAL_NAME)
    return { ok: false, value, message: `资料名最长 ${MAX_MATERIAL_NAME} 个字符` }
  const bad = [...value].find((ch) => ILLEGAL.includes(ch))
  if (bad)
    return { ok: false, value, message: `资料名不能包含 ${ILLEGAL.split('').join(' ')} 等字符` }
  const suffix = value.slice(value.lastIndexOf('.')).toLowerCase()
  if (!SUPPORTED_SUFFIXES.includes(suffix))
    return { ok: false, value, message: `资料名要保留类型后缀（${suffix || '缺后缀'}）` }
  return { ok: true, value, message: '' }
}

/** 改名是否真的改了（没改就不用发请求）。 */
export const isRealRename = (check: NameCheck, current: string) => check.ok && check.value !== current
