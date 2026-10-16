import { describe, expect, it } from 'vitest'

import { KIND_LABELS, MATERIAL_ACCEPT, MATERIAL_FORMAT_HINT } from '../api'
import type { Material } from '../api'
import {
  ZONE_KINDS,
  acceptFormatLabels,
  acceptHint,
  countByKind,
  defaultReaderView,
  firstImagePage,
  groupMaterials,
  hasAnyPageImage,
  hasPageImage,
  isPdfFile,
  normalizeKind,
  uploadTargetLabel,
  zoneEmptyLabel,
  zoneLabel,
  zoneUploadActionLabel,
} from './materialGroups'

const material = (patch: Partial<Material> & { id: number }): Material => ({
  filename: `材料-${patch.id}.pdf`,
  kind: 'slides',
  status: 'ready',
  error: '',
  chunk_count: 3,
  ...patch,
})

describe('normalizeKind / zoneLabel', () => {
  it('已知类型原样保留', () => {
    for (const kind of ZONE_KINDS) {
      expect(normalizeKind(kind)).toBe(kind)
      expect(zoneLabel(kind)).toBeTruthy()
    }
  })

  it('未知类型回落到 other', () => {
    expect(normalizeKind('unknown')).toBe('other')
    expect(normalizeKind('')).toBe('other')
    expect(zoneLabel('unknown')).toBe('其他')
  })

  it('auto 不是分区，也回落到 other', () => {
    expect(normalizeKind('auto')).toBe('other')
  })
})

describe('groupMaterials', () => {
  it('空列表仍返回全部分区，计数为 0', () => {
    const zones = groupMaterials([])
    expect(zones.map((z) => z.kind)).toEqual([...ZONE_KINDS])
    expect(zones.map((z) => z.count)).toEqual([0, 0, 0, 0, 0, 0])
    expect(zones.every((z) => z.materials.length === 0)).toBe(true)
  })

  it('分区顺序固定为 试题/课件/图片/教材/讲义/其他，与传入顺序无关', () => {
    const input = [
      material({ id: 1, kind: 'other' }),
      material({ id: 2, kind: 'handout' }),
      material({ id: 3, kind: 'slides' }),
      material({ id: 4, kind: 'exam' }),
      material({ id: 5, kind: 'textbook' }),
      material({ id: 6, kind: 'image' }),
    ]
    expect(groupMaterials(input).map((z) => z.kind)).toEqual([
      'exam',
      'slides',
      'image',
      'textbook',
      'handout',
      'other',
    ])
    expect(groupMaterials([...input].reverse()).map((z) => z.kind)).toEqual(
      groupMaterials(input).map((z) => z.kind),
    )
  })

  it('图片材料进入图片分区，标题取自 KIND_LABELS', () => {
    const zones = groupMaterials([material({ id: 1, kind: 'image', filename: '板书.png' })])
    const image = zones.find((z) => z.kind === 'image')
    expect(image?.label).toBe('图片')
    expect(image?.label).toBe(KIND_LABELS.image)
    expect(image?.count).toBe(1)
    expect(zones.find((z) => z.kind === 'other')?.count).toBe(0)
  })

  it('区内保持传入顺序，count 等于材料数', () => {
    const zones = groupMaterials([
      material({ id: 1, kind: 'slides', filename: 'a.pdf' }),
      material({ id: 2, kind: 'exam', filename: '卷A.pdf' }),
      material({ id: 3, kind: 'slides', filename: 'b.pdf' }),
      material({ id: 4, kind: 'exam', filename: '卷B.pdf' }),
    ])
    const slides = zones.find((z) => z.kind === 'slides')
    const exam = zones.find((z) => z.kind === 'exam')
    expect(slides?.materials.map((m) => m.filename)).toEqual(['a.pdf', 'b.pdf'])
    expect(exam?.materials.map((m) => m.filename)).toEqual(['卷A.pdf', '卷B.pdf'])
    expect(slides?.count).toBe(2)
    expect(exam?.count).toBe(2)
  })

  it('未知类型落入 other 分区并计入计数', () => {
    const zones = groupMaterials([
      material({ id: 1, kind: 'weird' }),
      material({ id: 2, kind: 'other' }),
    ])
    const other = zones.find((z) => z.kind === 'other')
    expect(other?.count).toBe(2)
    expect(other?.materials.map((m) => m.id)).toEqual([1, 2])
    expect(zones.reduce((sum, z) => sum + z.count, 0)).toBe(2)
  })

  it('hideEmpty 时只保留非空分区', () => {
    const zones = groupMaterials([material({ id: 1, kind: 'exam' })], { hideEmpty: true })
    expect(zones.map((z) => z.kind)).toEqual(['exam'])
  })

  it('所有分区计数之和恒等于材料总数', () => {
    const input = [
      material({ id: 1, kind: 'exam' }),
      material({ id: 2, kind: 'unknown' }),
      material({ id: 3, kind: 'slides' }),
      material({ id: 4, kind: 'slides' }),
    ]
    const zones = groupMaterials(input)
    expect(zones.reduce((sum, z) => sum + z.count, 0)).toBe(input.length)
    expect(zones.find((z) => z.kind === 'other')?.count).toBe(1)
  })
})

describe('countByKind', () => {
  it('空列表每个分区都是 0', () => {
    expect(countByKind([])).toEqual({
      exam: 0,
      slides: 0,
      image: 0,
      textbook: 0,
      handout: 0,
      other: 0,
    })
  })

  it('统计各分区数量，未知类型算进 other', () => {
    expect(
      countByKind([
        material({ id: 1, kind: 'exam' }),
        material({ id: 2, kind: 'exam' }),
        material({ id: 3, kind: 'textbook' }),
        material({ id: 4, kind: 'image' }),
        material({ id: 5, kind: '??? ' }),
      ]),
    ).toEqual({ exam: 2, slides: 0, image: 1, textbook: 1, handout: 0, other: 1 })
  })
})

describe('acceptFormatLabels / acceptHint', () => {
  it('把 Word / 图片的多个后缀合并为同一类', () => {
    expect(acceptFormatLabels('.doc,.docx')).toEqual(['Word'])
    expect(acceptFormatLabels('.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff')).toEqual(['图片'])
  })

  it('保持书写顺序并去重', () => {
    expect(acceptFormatLabels('.pdf,.pptx,.docx,.png,.doc,.pdf')).toEqual([
      'PDF',
      'PPTX',
      'Word',
      '图片',
    ])
  })

  it('未知后缀回退为大写后缀，不带点号', () => {
    expect(acceptFormatLabels('.xlsx, .PDF')).toEqual(['XLSX', 'PDF'])
  })

  it('空 accept 给出兜底提示', () => {
    expect(acceptFormatLabels('')).toEqual([])
    expect(acceptHint('')).toBe('支持的格式以文件选择器为准')
    expect(acceptHint(' , ')).toBe('支持的格式以文件选择器为准')
  })

  it('生成包含全部已接受格式的提示文案', () => {
    expect(acceptHint('.pdf,.pptx,.txt,.md')).toBe('支持 PDF / PPTX / TXT / MD')
    expect(acceptHint('.pdf,.docx,.png')).toBe('支持 PDF / Word / 图片')
  })

  it('api.ts 的 MATERIAL_ACCEPT 能派生出含 Word / 图片的提示，且不重复', () => {
    const labels = acceptFormatLabels(MATERIAL_ACCEPT)
    expect(labels).toContain('PDF')
    expect(labels).toContain('PPTX')
    expect(labels).toContain('Word')
    expect(labels).toContain('图片')
    expect(new Set(labels).size).toBe(labels.length)
    expect(acceptHint(MATERIAL_ACCEPT)).toBe(`支持 ${labels.join(' / ')}`)
    expect(labels.join(' / ')).toBe(MATERIAL_FORMAT_HINT)
  })
})

describe('分区上传文案', () => {
  it('上传目标：auto 显示自动识别，其余显示分区名', () => {
    expect(uploadTargetLabel('auto')).toBe('自动识别')
    expect(uploadTargetLabel('exam')).toBe('试题')
    expect(uploadTargetLabel('unknown')).toBe('其他')
  })

  it('分区上传按钮与空槽位文案', () => {
    expect(zoneUploadActionLabel('exam')).toBe('上传到「试题」')
    expect(zoneUploadActionLabel('image')).toBe('上传到「图片」')
    expect(zoneEmptyLabel('handout')).toBe('还没有讲义，点此上传')
    expect(zoneEmptyLabel('unknown')).toBe('还没有其他，点此上传')
  })
})

describe('原页图辅助判断', () => {
  it('isPdfFile 只看扩展名且大小写不敏感', () => {
    expect(isPdfFile('a.PDF')).toBe(true)
    expect(isPdfFile('a.pdf')).toBe(true)
    expect(isPdfFile('a.docx')).toBe(false)
  })

  it('PDF 任意页都有原页图', () => {
    const pdf = { filename: '课件.pdf', image_pages: [] }
    expect(hasAnyPageImage(pdf)).toBe(true)
    expect(hasPageImage(pdf, 1)).toBe(true)
    expect(hasPageImage(pdf, 99)).toBe(true)
  })

  it('Word / 图片材料只有 image_pages 里的页有原页图', () => {
    const docx = { filename: '讲义.docx', image_pages: [4, 7] }
    expect(hasAnyPageImage(docx)).toBe(true)
    expect(hasPageImage(docx, 4)).toBe(true)
    expect(hasPageImage(docx, 5)).toBe(false)
  })

  it('没有内嵌图的非 PDF 不显示原页图', () => {
    const docx = { filename: '讲义.docx', image_pages: [] }
    expect(hasAnyPageImage(docx)).toBe(false)
    expect(hasAnyPageImage({ filename: '讲义.docx' })).toBe(false)
    expect(hasPageImage({ filename: '讲义.docx' }, 1)).toBe(false)
  })

  it('firstImagePage 取最小图片页，没有则回落第 1 页', () => {
    expect(firstImagePage({ image_pages: [7, 3] })).toBe(3)
    expect(firstImagePage({ image_pages: [] })).toBe(1)
    expect(firstImagePage({})).toBe(1)
  })

  it('默认阅读视图：试题看题目、图片材料看原页图、其余看总结', () => {
    expect(defaultReaderView({ kind: 'exam', filename: '真题.pdf' })).toBe('problems')
    expect(defaultReaderView({ kind: 'slides', filename: '第1讲.pdf' })).toBe('summary')
    expect(defaultReaderView({ kind: 'image', filename: '板书.png', image_pages: [1] })).toBe('image')
    expect(defaultReaderView({ kind: 'image', filename: '板书.png' })).toBe('summary')
  })
})
