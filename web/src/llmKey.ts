/**
 * 自带密钥（BYOK）的浏览器端存储与请求头构造。
 *
 * 设计要点：
 * - 密钥只存在访问者自己的浏览器里，发给服务端仅作为「本次请求使用我的密钥」，
 *   服务端不会持久化；这不消耗部署者的额度。
 * - 全部逻辑是纯函数（除读写 localStorage 的两个入口），便于单测边界。
 */

export interface LlmCredentials {
  key: string
  baseUrl: string
  model: string
  /** 可选：对话服务商不提供 embeddings 时单独填（如 DeepSeek + DashScope） */
  embedKey: string
}

/** 后端约定的请求头名（与 server/app/config.py 保持一致）。 */
export const HEADER_KEY = 'X-LLM-API-Key'
export const HEADER_BASE_URL = 'X-LLM-Base-URL'
export const HEADER_MODEL = 'X-LLM-Model'
export const HEADER_EMBED_KEY = 'X-Embedding-API-Key'

export const EMPTY_CREDENTIALS: LlmCredentials = {
  key: '',
  baseUrl: '',
  model: '',
  embedKey: '',
}

const STORE_KEY = 'courseta.llm'
const MAX_FIELD = 300

/** 去掉首尾空白；超长的值一律丢弃（后端同样会忽略，避免请求头被滥用）。 */
function clean(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_FIELD) return ''
  return trimmed
}

/** 规范化任意输入为凭据对象，容忍缺字段与脏数据。 */
export function normalizeCredentials(input: Partial<LlmCredentials> | null | undefined): LlmCredentials {
  if (!input || typeof input !== 'object') return { ...EMPTY_CREDENTIALS }
  return {
    key: clean(input.key),
    baseUrl: clean(input.baseUrl),
    model: clean(input.model),
    embedKey: clean(input.embedKey),
  }
}

/** 是否配置了可用密钥（只有 key 是必填项）。 */
export function hasCredentials(c: LlmCredentials | null | undefined): boolean {
  return !!c && !!clean(c.key)
}

/**
 * 构造要附加到请求上的头。
 * 没有密钥时返回空对象——此时后端用服务端配置，与未实现 BYOK 时行为一致。
 */
export function credentialHeaders(c: LlmCredentials | null | undefined): Record<string, string> {
  const norm = normalizeCredentials(c)
  if (!norm.key) return {}
  const headers: Record<string, string> = { [HEADER_KEY]: norm.key }
  // baseUrl 允许指向本地 Ollama 等自建服务，因此即使没有 key 也单独支持
  if (norm.baseUrl) headers[HEADER_BASE_URL] = norm.baseUrl
  if (norm.model) headers[HEADER_MODEL] = norm.model
  // 对话服务商不支持 embeddings 时，需要单独提供向量密钥
  if (norm.embedKey) headers[HEADER_EMBED_KEY] = norm.embedKey
  return headers
}

/** 脱敏展示，例如 sk-abc…wxyz；用于界面回显，绝不显示完整密钥。 */
export function maskKey(key: string): string {
  const value = clean(key)
  if (!value) return ''
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

/** 一句话说明当前会用谁的额度，直接展示给访问者。 */
export function credentialSummary(
  c: LlmCredentials | null | undefined,
  serverHasKey: boolean,
  serverHasEmbedding = serverHasKey,
): string {
  if (hasCredentials(c)) return '使用你填写的密钥，不消耗部署者额度'
  if (serverHasKey) return '未填写密钥：使用服务端配置（消耗部署者额度）'
  if (serverHasEmbedding) return '未填写密钥：只有服务端向量额度可用，AI 问答不可用'
  return '未填写密钥：服务端未配置，AI 功能不可用'
}

/* ---------- localStorage 读写（唯一有副作用的部分） ---------- */

export function loadCredentials(): LlmCredentials {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return { ...EMPTY_CREDENTIALS }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY_CREDENTIALS }
    return normalizeCredentials(parsed as Partial<LlmCredentials>)
  } catch {
    return { ...EMPTY_CREDENTIALS }
  }
}

export function saveCredentials(c: LlmCredentials): LlmCredentials {
  const norm = normalizeCredentials(c)
  try {
    if (!norm.key && !norm.baseUrl && !norm.model && !norm.embedKey) {
      localStorage.removeItem(STORE_KEY)
    } else {
      localStorage.setItem(STORE_KEY, JSON.stringify(norm))
    }
  } catch {
    // 隐私模式等场景写不了：内存态仍然可用
  }
  return norm
}
