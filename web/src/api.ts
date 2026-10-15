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
  if (!resp.ok || !resp.body) throw new Error(`聊天请求失败: HTTP ${resp.status}`)

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
      const data = dataLines.join('\n')
      if (event === 'citations') opts.onCitations(JSON.parse(data))
      else if (event === 'delta') opts.onDelta(JSON.parse(data).text)
      else if (event === 'error') throw new Error(JSON.parse(data).message)
    }
  }
}
