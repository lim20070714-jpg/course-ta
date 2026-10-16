import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_CREDENTIALS,
  HEADER_BASE_URL,
  HEADER_KEY,
  HEADER_MODEL,
  credentialHeaders,
  credentialSummary,
  hasCredentials,
  loadCredentials,
  maskKey,
  normalizeCredentials,
  saveCredentials,
} from './llmKey'
import type { LlmCredentials } from './llmKey'

/** 构造完整凭据，避免每个用例重复写全部字段。 */
const creds = (patch: Partial<LlmCredentials> = {}): LlmCredentials => ({
  ...EMPTY_CREDENTIALS,
  ...patch,
})

/**
 * 测试环境是 node（仓库未安装 jsdom），因此这里用一个内存版 localStorage 打桩。
 * 这样既能覆盖真实读写路径，也不必为几个纯函数引入整个 DOM 环境。
 */
function installMemoryStorage(): Storage {
  const map = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  }
  vi.stubGlobal('localStorage', storage)
  return storage
}

describe('normalizeCredentials', () => {
  it('缺字段与脏数据安全回退', () => {
    expect(normalizeCredentials(null)).toEqual(EMPTY_CREDENTIALS)
    expect(normalizeCredentials(undefined)).toEqual(EMPTY_CREDENTIALS)
    expect(normalizeCredentials({ key: 123 as unknown as string })).toEqual(EMPTY_CREDENTIALS)
  })

  it('去掉首尾空白', () => {
    expect(normalizeCredentials({ key: '  sk-abc  ' }).key).toBe('sk-abc')
  })

  it('丢弃超长值，避免把长串塞进请求头', () => {
    const long = 'x'.repeat(500)
    expect(normalizeCredentials({ key: long }).key).toBe('')
    expect(normalizeCredentials({ key: 'x'.repeat(300) }).key).toHaveLength(300)
  })

  it('只填 baseUrl 也保留（本地 Ollama 无需 key）', () => {
    const c = normalizeCredentials({ baseUrl: 'http://localhost:11434/v1' })
    expect(c.baseUrl).toBe('http://localhost:11434/v1')
    expect(c.key).toBe('')
  })
})

describe('hasCredentials', () => {
  it('只有 key 是必填项', () => {
    expect(hasCredentials(EMPTY_CREDENTIALS)).toBe(false)
    expect(hasCredentials(null)).toBe(false)
    expect(hasCredentials(creds({ key: 'sk-1' }))).toBe(true)
    expect(hasCredentials(creds({ baseUrl: 'http://x' }))).toBe(false)
  })
})

describe('credentialHeaders', () => {
  it('未配置密钥时不附加任何头（与以前行为一致）', () => {
    expect(credentialHeaders(EMPTY_CREDENTIALS)).toEqual({})
    expect(credentialHeaders(null)).toEqual({})
    expect(credentialHeaders(creds({ baseUrl: 'http://x' }))).toEqual({})
  })

  it('带密钥时给出全部三项', () => {
    expect(
      credentialHeaders(creds({ key: 'sk-abc', baseUrl: 'https://api.example.com/v1', model: 'm1' })),
    ).toEqual({
      [HEADER_KEY]: 'sk-abc',
      [HEADER_BASE_URL]: 'https://api.example.com/v1',
      [HEADER_MODEL]: 'm1',
    })
  })

  it('只填密钥时只给密钥头，不发送空的自定义头', () => {
    const headers = credentialHeaders(creds({ key: 'sk-abc' }))
    expect(Object.keys(headers)).toEqual([HEADER_KEY])
  })

  it('单独填向量密钥时附带向量头（对话服务商无 embeddings 的场景）', () => {
    const headers = credentialHeaders(creds({ key: 'sk-chat', embedKey: 'sk-embed' }))
    expect(headers[HEADER_KEY]).toBe('sk-chat')
    expect(headers['X-Embedding-API-Key']).toBe('sk-embed')
  })

  it('没有对话密钥时整体不附带任何头（向量密钥不能单独生效）', () => {
    expect(credentialHeaders(creds({ embedKey: 'sk-embed' }))).toEqual({})
  })

  it('先规范化再构造，空白不会变成有效头', () => {
    expect(credentialHeaders(creds({ key: '   ', baseUrl: '  ', model: '  ' }))).toEqual({})
  })
})

describe('maskKey', () => {
  it('短密钥只显示圆点', () => {
    expect(maskKey('short')).toBe('••••')
    expect(maskKey('')).toBe('')
  })

  it('长密钥保留首尾便于辨认', () => {
    expect(maskKey('sk-1234567890abcdef')).toBe('sk-1…cdef')
  })

  it('绝不返回完整密钥', () => {
    const key = 'sk-abcdefghijklmnop'
    expect(maskKey(key)).not.toBe(key)
    expect(maskKey(key).length).toBeLessThan(key.length)
  })
})

describe('credentialSummary', () => {
  it('四种状态文案互不相同', () => {
    const mine = credentialSummary(creds({ key: 'sk-1' }), true)
    const server = credentialSummary(EMPTY_CREDENTIALS, true)
    const embedOnly = credentialSummary(EMPTY_CREDENTIALS, false, true)
    const none = credentialSummary(EMPTY_CREDENTIALS, false, false)
    expect(new Set([mine, server, embedOnly, none]).size).toBe(4)
    expect(mine).toContain('不消耗部署者额度')
    expect(embedOnly).toContain('向量额度')
  })
})

describe('localStorage 读写', () => {
  beforeEach(() => {
    installMemoryStorage()
  })

  it('未保存时返回空凭据', () => {
    expect(loadCredentials()).toEqual(EMPTY_CREDENTIALS)
  })

  it('保存后能读回（规范化后）', () => {
    saveCredentials(creds({ key: ' sk-1 ', baseUrl: ' https://a ' }))
    expect(loadCredentials()).toEqual(creds({ key: 'sk-1', baseUrl: 'https://a' }))
  })

  it('清空后移除存储项', () => {
    saveCredentials(creds({ key: 'sk-1' }))
    saveCredentials(EMPTY_CREDENTIALS)
    expect(localStorage.getItem('courseta.llm')).toBeNull()
    expect(loadCredentials()).toEqual(EMPTY_CREDENTIALS)
  })

  it('存储内容损坏时安全回退', () => {
    localStorage.setItem('courseta.llm', 'not json')
    expect(loadCredentials()).toEqual(EMPTY_CREDENTIALS)
    localStorage.setItem('courseta.llm', '"a string"')
    expect(loadCredentials()).toEqual(EMPTY_CREDENTIALS)
  })

  it('localStorage 抛错时不影响内存态（隐私模式）', () => {
    const failing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    } as unknown as Storage
    vi.stubGlobal('localStorage', failing)
    expect(loadCredentials()).toEqual(EMPTY_CREDENTIALS)
    expect(() => saveCredentials(creds({ key: 'sk-1' }))).not.toThrow()
    installMemoryStorage()
  })
})
