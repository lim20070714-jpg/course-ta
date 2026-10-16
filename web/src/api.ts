export interface Course {
  id: number
  name: string
  description: string
}

export interface Material {
  id: number
  filename: string
  kind: string
  status: string
  error: string
  chunk_count: number
  page_count?: number
  image_pages?: number[]
}

export const KIND_LABELS: Record<string, string> = {
  textbook: '教材',
  slides: '课件',
  handout: '讲义',
  exam: '试题',
  image: '图片',
  other: '其他',
}

export const materialKindLabel = (kind: string) => KIND_LABELS[kind] ?? kind

// 与后端 SUPPORTED_SUFFIXES 保持一致的上传格式（含 Word 与图片）
export const MATERIAL_ACCEPT = '.pdf,.pptx,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff'

// 上传区展示用的可读格式说明
export const MATERIAL_FORMAT_HINT = 'PDF / PPTX / Word / TXT / MD / 图片'

export interface Citation {
  material_id: number
  material: string
  page: number
  snippet: string
}

export interface PageOut {
  page: number
  text: string
}

export interface MaterialPages {
  material_id: number
  filename: string
  page_count: number
  offset: number
  limit: number
  pages: PageOut[]
}

export interface SearchHit {
  material_id: number
  material: string
  page: number
  snippet: string
}

export interface SearchResponse {
  query: string
  hits: SearchHit[]
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface ProblemSource {
  material_id: number
  filename: string
  kind: string
  status: string
  problem_count: number
  job_status: string
  job_error: string
}

export interface ProblemListItem {
  id: number
  material_id: number | null
  material: string
  page: number
  number: string
  excerpt: string
  knowledge: string[]
  attempt_count: number
  last_verdict: string
}

export interface ProblemList {
  total: number
  items: ProblemListItem[]
}

export interface Attempt {
  id: number
  answer_text: string
  verdict: string
  feedback: string
  created_at: string
}

export interface ProblemDetail {
  id: number
  course_id: number
  material_id: number | null
  material: string
  page: number
  number: string
  stem: string
  answer: string
  knowledge: string[]
  attempts: Attempt[]
}

export interface TagCount {
  tag: string
  count: number
}

export interface KeyPoint {
  title: string
  detail: string
  pages: number[]
}

export interface MaterialSummary {
  material_id: number
  status: string // pending | generating | ready | failed
  overview: string
  key_points: KeyPoint[]
  error: string
}

export const getMaterialSummary = (materialId: number) =>
  fetch(`/api/materials/${materialId}/summary`).then((r) => json<MaterialSummary>(r))

export const regenerateSummary = (materialId: number) =>
  fetch(`/api/materials/${materialId}/summary`, { method: 'POST' }).then((r) =>
    json<{ status: string }>(r),
  )

export interface ComputePayload {
  expr: string
  op: string
  var?: string
  point?: string
  lower?: string
  upper?: string
  order?: number
  symbols?: { name: string; kind: string }[]
}

export interface ComputeResult {
  latex: string
  plain: string
  approx: string
}

export const evaluateCompute = (payload: ComputePayload) =>
  fetch('/api/compute/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => json<ComputeResult>(r))

export interface Formula {
  id: number
  title: string
  latex: string
  category: string
  note: string
  preset: boolean
}

export const listFormulas = () => fetch('/api/formulas').then((r) => json<Formula[]>(r))

export const createFormula = (payload: Partial<Formula> & { title: string; latex: string }) =>
  fetch('/api/formulas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => json<Formula>(r))

export const updateFormula = (id: number, payload: Partial<Formula>) =>
  fetch(`/api/formulas/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => json<Formula>(r))

export const deleteFormula = (id: number) =>
  fetch(`/api/formulas/${id}`, { method: 'DELETE' }).then((r) => json<{ status: string }>(r))

export interface WrongItem extends ProblemListItem {
  last_feedback: string
}

export interface GraphProblemRef {
  id: number
  number: string
  material: string
}

export interface GraphNode {
  id: number
  name: string
  description: string
  module: string
  order: number
  material_id: number | null
  material: string
  page: number
  problems: GraphProblemRef[]
}

export interface GraphEdge {
  source: number
  target: number
  relation: string // prerequisite | related
  note: string
}

export interface CourseGraph {
  course_id: number
  status: string // pending | generating | ready | failed
  error: string
  overview: string
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export const getCourseGraph = (courseId: number) =>
  fetch(`/api/courses/${courseId}/graph`).then((r) => json<CourseGraph>(r))

export const regenerateGraph = (courseId: number) =>
  fetch(`/api/courses/${courseId}/graph`, { method: 'POST' }).then((r) =>
    json<{ status: string }>(r),
  )

async function json<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const detail = await resp.json().catch(() => null)
    throw new Error(detail?.detail ?? `HTTP ${resp.status}`)
  }
  return resp.json() as Promise<T>
}

export const listCourses = () => fetch('/api/courses').then((r) => json<Course[]>(r))

export const createCourse = (name: string) =>
  fetch('/api/courses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then((r) => json<Course>(r))

export const listMaterials = (courseId: number) =>
  fetch(`/api/courses/${courseId}/materials`).then((r) => json<Material[]>(r))

export const materialPages = (materialId: number, offset = 0, limit = 20) =>
  fetch(`/api/materials/${materialId}/pages?offset=${offset}&limit=${limit}`).then((r) =>
    json<MaterialPages>(r),
  )

export const searchCourse = (courseId: number, q: string, limit = 30) =>
  fetch(`/api/courses/${courseId}/search?q=${encodeURIComponent(q)}&limit=${limit}`).then((r) =>
    json<SearchResponse>(r),
  )

export async function uploadMaterial(
  courseId: number,
  file: File,
  kind = 'auto',
): Promise<Material> {
  const form = new FormData()
  form.append('file', file)
  form.append('kind', kind)
  return json<Material>(await fetch(`/api/courses/${courseId}/materials`, { method: 'POST', body: form }))
}

export const updateMaterialKind = (materialId: number, kind: string) =>
  fetch(`/api/materials/${materialId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind }),
  }).then((r) => json<Material>(r))

export const listProblemSources = (courseId: number) =>
  fetch(`/api/courses/${courseId}/problem-sources`).then((r) => json<ProblemSource[]>(r))

export const extractProblems = (materialId: number) =>
  fetch(`/api/materials/${materialId}/extract-problems`, { method: 'POST' }).then((r) =>
    json<{ status: string }>(r),
  )

export interface ProblemFilters {
  materialId?: number | null
  knowledge?: string
  status?: string
  q?: string
  offset?: number
  limit?: number
}

export const listProblems = (courseId: number, f: ProblemFilters = {}) => {
  const params = new URLSearchParams()
  if (f.materialId != null) params.set('material_id', String(f.materialId))
  if (f.knowledge) params.set('knowledge', f.knowledge)
  if (f.status) params.set('status', f.status)
  if (f.q) params.set('q', f.q)
  params.set('offset', String(f.offset ?? 0))
  params.set('limit', String(f.limit ?? 100))
  return fetch(`/api/courses/${courseId}/problems?${params}`).then((r) => json<ProblemList>(r))
}

export const getProblem = (id: number) =>
  fetch(`/api/problems/${id}`).then((r) => json<ProblemDetail>(r))

export const listProblemTags = (courseId: number) =>
  fetch(`/api/courses/${courseId}/problem-tags`).then((r) => json<TagCount[]>(r))

export const getWrongbook = (courseId: number) =>
  fetch(`/api/courses/${courseId}/wrongbook`).then((r) => json<WrongItem[]>(r))

export const pageImageUrl = (materialId: number, page: number) =>
  `/api/materials/${materialId}/page-image?page=${page}`

export const problemImageUrl = (problemId: number, zoom = 2) =>
  `/api/problems/${problemId}/image?zoom=${zoom}`

export const fetchHint = (problemId: number) =>
  fetch(`/api/problems/${problemId}/hint`, { method: 'POST' }).then((r) =>
    json<{ hint: string }>(r),
  )

async function streamSSE(resp: Response, on: (event: string, data: string) => void): Promise<void> {
  if (!resp.ok || !resp.body) {
    const detail = await resp.json().catch(() => null)
    throw new Error(detail?.detail ?? `请求失败: HTTP ${resp.status}`)
  }
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      let event = 'message'
      const dataLines: string[] = []
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }
      on(event, dataLines.join('\n'))
    }
  }
}

export async function streamChat(opts: {
  courseId: number
  question: string
  history: ChatTurn[]
  onCitations: (citations: Citation[]) => void
  onDelta: (text: string) => void
}): Promise<void> {
  const resp = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      course_id: opts.courseId,
      question: opts.question,
      history: opts.history,
    }),
  })
  await streamSSE(resp, (event, data) => {
    if (event === 'citations') opts.onCitations(JSON.parse(data))
    else if (event === 'delta') opts.onDelta(JSON.parse(data).text)
    else if (event === 'error') throw new Error(JSON.parse(data).message)
  })
}

export async function streamGrade(opts: {
  problemId: number
  answer: string
  onVerdict: (verdict: string) => void
  onDelta: (text: string) => void
}): Promise<void> {
  const resp = await fetch(`/api/problems/${opts.problemId}/grade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: opts.answer }),
  })
  await streamSSE(resp, (event, data) => {
    if (event === 'verdict') opts.onVerdict(JSON.parse(data).verdict)
    else if (event === 'delta') opts.onDelta(JSON.parse(data).text)
    else if (event === 'error') throw new Error(JSON.parse(data).message)
  })
}

export async function streamSolution(opts: {
  problemId: number
  onCitations: (citations: Citation[]) => void
  onDelta: (text: string) => void
}): Promise<void> {
  const resp = await fetch(`/api/problems/${opts.problemId}/solution`, { method: 'POST' })
  await streamSSE(resp, (event, data) => {
    if (event === 'citations') opts.onCitations(JSON.parse(data))
    else if (event === 'delta') opts.onDelta(JSON.parse(data).text)
    else if (event === 'error') throw new Error(JSON.parse(data).message)
  })
}

export interface ReviewCard {
  problem_id: number
  course_id: number
  ease: number
  interval_days: number
  reps: number
  lapses: number
  due_at: string
  last_review_at: string | null
}

export interface ReviewDueItem extends ReviewCard {
  number: string
  material: string
  page: number
  excerpt: string
  knowledge: string[]
  // 冲刺模式附加字段：非冲刺期为 0 / 空数组（后端可能不返回，故可选）
  weight?: number
  reasons?: string[]
}

export interface SprintRecommendation {
  knowledge: string
  count: number
  score: number
}

export interface ReviewSprint {
  course_id: number
  exam_date: string | null
  days_left: number | null
  sprint: boolean
  status: string // none | over | sprint | normal
  schedule: number[]
  stage: string
  due_count: number
  sprint_pool: number
  recommended: number
  tag_total: number
  message: string
  top_tags: SprintRecommendation[]
}

export interface ExamDateResult {
  course_id: number
  exam_date: string | null
}

export interface ReviewStats {
  card_count: number
  due_now: number
  reviewed_today: number
  forecast: { date: string; count: number }[]
}

export const getReviewStats = (courseId: number) =>
  fetch(`/api/courses/${courseId}/review/stats`).then((r) => json<ReviewStats>(r))

// exam=true 时后端进入考试冲刺模式：包含未到期卡片并按考点热度加权排序
export const getReviewDue = (courseId: number, limit = 100, exam = false) =>
  fetch(`/api/courses/${courseId}/review/due?limit=${limit}${exam ? '&exam=true' : ''}`).then(
    (r) => json<ReviewDueItem[]>(r),
  )

export const getReviewCards = (courseId: number) =>
  fetch(`/api/courses/${courseId}/review/cards`).then((r) => json<ReviewDueItem[]>(r))

// 考试冲刺模式：考试日期 + 距离天数 + 压缩节奏 + 高频考点
export const getReviewSprint = (courseId: number) =>
  fetch(`/api/courses/${courseId}/review/sprint`).then((r) => json<ReviewSprint>(r))

// examDate 传 "YYYY-MM-DD"；传 null 清除考试日期
export const setExamDate = (courseId: number, examDate: string | null) =>
  fetch(`/api/courses/${courseId}/exam-date`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exam_date: examDate }),
  }).then((r) => json<ExamDateResult>(r))

export const getProblemReview = (problemId: number) =>
  fetch(`/api/problems/${problemId}/review`).then((r) => json<ReviewCard | null>(r))

export const enrollReview = (problemId: number) =>
  fetch(`/api/problems/${problemId}/review`, { method: 'PUT' }).then((r) =>
    json<ReviewCard>(r),
  )

export const removeReview = (problemId: number) =>
  fetch(`/api/problems/${problemId}/review`, { method: 'DELETE' }).then((r) =>
    json<{ status: string }>(r),
  )

export const gradeReview = (problemId: number, quality: number) =>
  fetch(`/api/problems/${problemId}/review/grade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quality }),
  }).then((r) => json<ReviewCard>(r))
