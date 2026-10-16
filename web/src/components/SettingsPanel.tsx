import { useEffect, useMemo, useState } from 'react'
import { getRuntimeConfig } from '../api'
import type { RuntimeConfig } from '../api'
import type { LlmCredentials } from '../llmKey'
import {
  EMPTY_CREDENTIALS,
  credentialSummary,
  hasCredentials,
  maskKey,
  normalizeCredentials,
  saveCredentials,
} from '../llmKey'

/**
 * 设置面板：让访问者填自己的 LLM 密钥（自带密钥 / BYOK）。
 *
 * 密钥只存在本浏览器的 localStorage，随请求头发给服务端按次使用、不落库，
 * 因此共享实例上不会消耗部署者的额度。这一点在界面上必须写清楚。
 */
export default function SettingsPanel({
  credentials,
  onChange,
  onClose,
}: {
  credentials: LlmCredentials
  onChange: (next: LlmCredentials) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<LlmCredentials>(credentials)
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    getRuntimeConfig()
      .then(setRuntime)
      .catch(() => setRuntime(null))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const summary = useMemo(
    () =>
      credentialSummary(
        draft,
        runtime?.server_key_configured ?? false,
        runtime?.server_embedding_configured ?? runtime?.server_key_configured ?? false,
      ),
    [draft, runtime],
  )
  const dirty =
    normalizeCredentials(draft).key !== normalizeCredentials(credentials).key ||
    normalizeCredentials(draft).baseUrl !== normalizeCredentials(credentials).baseUrl ||
    normalizeCredentials(draft).model !== normalizeCredentials(credentials).model

  function save() {
    onChange(saveCredentials(draft))
    setSaved(true)
    setTimeout(() => setSaved(false), 1600)
  }

  function clear() {
    setDraft(EMPTY_CREDENTIALS)
    onChange(saveCredentials(EMPTY_CREDENTIALS))
  }

  return (
    <div className="cmdk-backdrop" onMouseDown={onClose}>
      <div
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <h2>设置 · AI 密钥</h2>
          <button className="mini ghost" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <p className={`settings-status${hasCredentials(draft) ? ' ok' : ''}`}>
          <span className="settings-dot" />
          {summary}
        </p>

        <label className="settings-field">
          <span>API Key</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-…（填写后由你的账号计费）"
            value={draft.key}
            onChange={(e) => setDraft({ ...draft, key: e.target.value })}
          />
        </label>

        <label className="settings-field">
          <span>接口地址（可选）</span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={runtime?.server_base_url ?? 'https://api.deepseek.com/v1'}
            value={draft.baseUrl}
            onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
          />
        </label>

        <label className="settings-field">
          <span>模型（可选）</span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={runtime?.server_model ?? 'deepseek-chat'}
            value={draft.model}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          />
        </label>

        <label className="settings-field">
          <span>向量模型 API Key（可选）</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="对话服务商不支持 embeddings 时单独填写（如 DeepSeek + DashScope）"
            value={draft.embedKey}
            onChange={(e) => setDraft({ ...draft, embedKey: e.target.value })}
          />
        </label>

        <div className="settings-note">
          <strong>密钥只保存在这个浏览器</strong>，随请求头发给当前服务端按次使用，服务端不会保存；
          因此共用别人的实例时，消耗的是你自己的额度。
          {runtime && !runtime.server_key_configured && (
            <>
              <br />
              当前服务端<b>没有</b>配置密钥，不填就无法使用 AI 功能。
            </>
          )}
          {hasCredentials(credentials) && (
            <>
              <br />
              已保存：<code>{maskKey(credentials.key)}</code>
            </>
          )}
        </div>

        <div className="settings-actions">
          <button onClick={save} disabled={!dirty && hasCredentials(credentials)}>
            {saved ? '已保存' : '保存'}
          </button>
          <button className="ghost-btn" onClick={clear} disabled={!hasCredentials(draft)}>
            清除
          </button>
        </div>
      </div>
    </div>
  )
}
