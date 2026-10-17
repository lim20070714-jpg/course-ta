import { describe, expect, it } from 'vitest'
import { basename, checkCourseName, checkMaterialName, isRealRename, MAX_MATERIAL_NAME } from './rename'

describe('checkCourseName', () => {
  it('去掉首尾空格后才算名字', () => {
    expect(checkCourseName('  电路原理  ')).toEqual({ ok: true, value: '电路原理', message: '' })
  })

  it('拒绝空名字与过长名字', () => {
    expect(checkCourseName('   ').ok).toBe(false)
    expect(checkCourseName('电'.repeat(61)).message).toContain('最长')
  })
})

describe('checkMaterialName', () => {
  it('剥掉目录成分，只留文件名', () => {
    expect(basename('/etc/passwd.pdf')).toBe('passwd.pdf')
    expect(basename('C:\\Users\\me\\ Downloads\\课件.PDF')).toBe('课件.PDF')
    expect(checkMaterialName('../../目录/期末卷.pdf').value).toBe('期末卷.pdf')
  })

  it('必须保留支持的类型后缀', () => {
    expect(checkMaterialName('notes.doc').message).toContain('后缀')
    expect(checkMaterialName('lecture').message).toContain('后缀')
    expect(checkMaterialName('讲义.md').ok).toBe(true)
    expect(checkMaterialName('扫描件.JPG').ok).toBe(true)
  })

  it('拒绝文件系统非法字符', () => {
    for (const bad of ['a<b.pdf', 'a>b.pdf', 'a:b.pdf', 'a"b.pdf', 'a|b.pdf', 'a?b.pdf', 'a*b.pdf']) {
      expect(checkMaterialName(bad).ok, bad).toBe(false)
    }
  })

  it('拒绝空名字与超长名字', () => {
    expect(checkMaterialName(' .. ').ok).toBe(false)
    expect(checkMaterialName(`${'长'.repeat(MAX_MATERIAL_NAME)}.pdf`).message).toContain('最长')
  })
})

describe('isRealRename', () => {
  it('名字没变或校验不过都不算改名', () => {
    expect(isRealRename(checkMaterialName(' 期末卷.pdf '), '期末卷.pdf')).toBe(false)
    expect(isRealRename(checkMaterialName('新名字.pdf'), '期末卷.pdf')).toBe(true)
    expect(isRealRename(checkMaterialName('无后缀'), '期末卷.pdf')).toBe(false)
  })
})
