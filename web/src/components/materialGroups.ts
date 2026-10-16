import { KIND_LABELS } from '../api'
import type { Material } from '../api'

/**
 * 资料分区（zone）纯逻辑：
 * 按材料类型把材料分成固定顺序的分区，供侧边栏分区展示 + 分区上传使用。
 * 这里只做纯计算，不依赖 React，便于单测。
 */

/**
 * 分区顺序：试题优先（考试冲刺时最先要看的资料）；课件每次上课都翻；
 * 图片（板书/截图/拍照）多是速查的碎片内容；教材与讲义是长文本精读；
 * 其他最后。顺序固定，保证多次渲染/多次分组结果稳定。
 */
export const ZONE_KINDS = ['exam', 'slides', 'image', 'textbook', 'handout', 'other'] as const

export type ZoneKind = (typeof ZONE_KINDS)[number]

/** 上传类型下拉里的「自动识别」项；不是真实分区。 */
export const AUTO_KIND = 'auto'

export interface MaterialZone {
  /** 归一化后的类型 key，如 exam / other */
  kind: ZoneKind
  /** 中文分区名，如 试题 */
  label: string
  /** 本区材料数量 */
  count: number
  /** 本区材料，保持传入顺序 */
  materials: Material[]
}

/** 未知类型一律归入 other（其他），保证每个材料都有归属分区。 */
export function normalizeKind(kind: string): ZoneKind {
  return (ZONE_KINDS as readonly string[]).includes(kind) ? (kind as ZoneKind) : 'other'
}

/** 分区标题：未知类型回落到「其他」。 */
export function zoneLabel(kind: string): string {
  return KIND_LABELS[normalizeKind(kind)] ?? '其他'
}

/**
 * 把材料按类型分组为有序分区。
 * - 顺序恒为 ZONE_KINDS，与传入顺序无关（稳定排序）。
 * - 区内保持传入顺序。
 * - 默认包含空分区：空分区在界面上是「点此上传」的槽位，这样新课程也能直接往目标分区上传。
 * - hideEmpty 用于筛选场景：筛选时隐藏空分区，避免结果被空槽位淹没。
 */
export function groupMaterials(
  materials: readonly Material[],
  options: { hideEmpty?: boolean } = {},
): MaterialZone[] {
  const buckets = new Map<string, Material[]>()
  for (const kind of ZONE_KINDS) buckets.set(kind, [])
  for (const material of materials) {
    const list = buckets.get(normalizeKind(material.kind))
    if (list) list.push(material)
  }
  const zones: MaterialZone[] = []
  for (const kind of ZONE_KINDS) {
    const list = buckets.get(kind) ?? []
    if (options.hideEmpty && list.length === 0) continue
    zones.push({ kind, label: KIND_LABELS[kind] ?? kind, count: list.length, materials: list })
  }
  return zones
}

/** 每个分区的材料数量（含固定出现的 other）。 */
export function countByKind(materials: readonly Material[]): Record<ZoneKind, number> {
  const counts = {} as Record<ZoneKind, number>
  for (const kind of ZONE_KINDS) counts[kind] = 0
  for (const material of materials) {
    const kind = normalizeKind(material.kind)
    counts[kind] += 1
  }
  return counts
}

/** 侧边栏「上传到：X」文案；auto 表示交给后端按文件名自动识别。 */
export function uploadTargetLabel(kind: string): string {
  return kind === AUTO_KIND ? '自动识别' : zoneLabel(kind)
}

/** 后缀 → 展示用格式名；Word / 图片合并成同一类，避免重复刷屏。 */
const EXTENSION_LABELS: Record<string, string> = {
  pdf: 'PDF',
  ppt: 'PPT',
  pptx: 'PPTX',
  doc: 'Word',
  docx: 'Word',
  txt: 'TXT',
  md: 'MD',
  png: '图片',
  jpg: '图片',
  jpeg: '图片',
  webp: '图片',
  gif: '图片',
  bmp: '图片',
  tif: '图片',
  tiff: '图片',
}

/**
 * 解析 <input accept> 的值（如 ".pdf,.docx,.png"）为去重后的格式名列表，保持书写顺序。
 * 未知后缀回退为大写后缀，保证提示文案与真实 accept 永不脱节。
 */
export function acceptFormatLabels(accept: string): string[] {
  const labels: string[] = []
  for (const token of accept.split(',')) {
    const trimmed = token.trim().toLowerCase()
    if (!trimmed) continue
    const ext = trimmed.startsWith('.') ? trimmed.slice(1) : trimmed
    const label = EXTENSION_LABELS[ext] ?? ext.toUpperCase()
    if (!labels.includes(label)) labels.push(label)
  }
  return labels
}

const EMPTY_ACCEPT_HINT = '支持的格式以文件选择器为准'

/** 上传提示文案，如「支持 PDF / PPTX / Word / 图片」。 */
export function acceptHint(accept: string): string {
  const labels = acceptFormatLabels(accept)
  return labels.length === 0 ? EMPTY_ACCEPT_HINT : `支持 ${labels.join(' / ')}`
}

/** 分区上传按钮 / 空槽位文案，如「上传到「试题」」或「还没有试题，点此上传」。 */
export function zoneUploadActionLabel(kind: string): string {
  return `上传到「${zoneLabel(kind)}」`
}

/** 空分区槽位文案。 */
export function zoneEmptyLabel(kind: string): string {
  return `还没有${zoneLabel(kind)}，点此上传`
}

/* ===== 分区收纳（折叠 / 展开）===== */

/** 折叠状态：记录被收起的分区类型。 */
export type CollapsedZones = ReadonlySet<ZoneKind>

export function noZonesCollapsed(): CollapsedZones {
  return new Set<ZoneKind>()
}

/** 切换某个分区的折叠状态，返回新集合（不改动入参）。 */
export function toggleZone(collapsed: CollapsedZones, kind: string): Set<ZoneKind> {
  const key = normalizeKind(kind)
  const next = new Set(collapsed)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

export function isZoneCollapsed(collapsed: CollapsedZones, kind: string): boolean {
  return collapsed.has(normalizeKind(kind))
}

/** 全部收起：只保留当前有材料的分区，避免收起一堆空分区反而更难找。 */
export function collapseAllZones(zones: readonly MaterialZone[]): Set<ZoneKind> {
  return new Set(zones.filter((z) => z.count > 0).map((z) => z.kind))
}

export function expandAllZones(): Set<ZoneKind> {
  return new Set<ZoneKind>()
}

/** 是否全部可见分区都已收起（用于「全部展开 / 全部收起」按钮的文案与禁用态）。 */
export function allZonesCollapsed(
  collapsed: CollapsedZones,
  zones: readonly MaterialZone[],
): boolean {
  const nonEmpty = zones.filter((z) => z.count > 0)
  return nonEmpty.length > 0 && nonEmpty.every((z) => collapsed.has(z.kind))
}

/**
 * 折叠后要展示的一行摘要，说明"这里被收起了多少东西"，
 * 与图谱折叠模块章显示「N 隐藏」保持同一套语言。
 */
export function collapsedZoneSummary(zone: MaterialZone): string {
  if (zone.count === 0) return '空'
  return `${zone.count} 份已收起`
}

/* ===== 原页图（PDF 渲染页 / Word 内嵌图 / 图片材料）===== */

/** 文件名是否为 PDF：PDF 的每一页都能渲染成原页图。 */
export function isPdfFile(filename: string): boolean {
  return filename.toLowerCase().endsWith('.pdf')
}

/** 材料是否存在可见的原页图（用于决定是否显示「原页图」页签）。 */
export function hasAnyPageImage(material: Pick<Material, 'filename' | 'image_pages'>): boolean {
  return isPdfFile(material.filename) || (material.image_pages?.length ?? 0) > 0
}

/** 某一页是否有原页图可看：PDF 恒为真；其他格式只有内嵌图片的页才有。 */
export function hasPageImage(
  material: Pick<Material, 'filename' | 'image_pages'>,
  page: number,
): boolean {
  if (isPdfFile(material.filename)) return true
  return (material.image_pages ?? []).includes(page)
}

/** 第一个可看原页图的页码（图片材料默认从这页打开）。 */
export function firstImagePage(material: { image_pages?: number[] }): number {
  const pages = material.image_pages ?? []
  return pages.length > 0 ? Math.min(...pages) : 1
}

/** 阅读区可切换的视图名。 */
export type ReaderViewName = 'summary' | 'text' | 'image' | 'problems'

/** 打开材料时的默认阅读视图。 */
export function defaultReaderView(
  material: Pick<Material, 'kind' | 'filename' | 'image_pages'>,
): ReaderViewName {
  if (material.kind === 'exam') return 'problems'
  if (material.kind === 'image' && hasAnyPageImage(material)) return 'image'
  return 'summary'
}
