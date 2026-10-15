export interface Course {
  id: number
  name: string
  description: string
}

export interface Material {
  id: number
  filename: string
  status: string
  error: string
  chunk_count: number
}

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

export interface WrongItem extends ProblemListItem {
  last_feedback: string
}

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

export async function uploadMaterial(courseId: number, file: File): Promise<Material> {
  const form = new FormData()
  form.append('file', file)
  return json<Material>(await fetch(`/api/courses/${courseId}/materials`, { method: 'POST', body: form }))
}

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
