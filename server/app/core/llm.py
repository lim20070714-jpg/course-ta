import json
from collections.abc import AsyncIterator

import httpx

from app import config

_TIMEOUT = httpx.Timeout(120.0, connect=20.0)


class LLMNotConfigured(RuntimeError):
    pass


def _bearer(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"} if key else {}


def _require_chat_key(cfg: config.EffectiveSettings) -> None:
    if cfg.llm_api_key:
        return
    if "localhost" in cfg.llm_base_url or "127.0.0.1" in cfg.llm_base_url:
        return  # 本地模型（如 Ollama）通常不需要 key
    raise LLMNotConfigured("未配置 LLM_API_KEY，请在 server/.env 中填写（参考 .env.example）")


async def chat_stream(messages: list[dict]) -> AsyncIterator[str]:
    """流式调用对话模型（OpenAI 兼容 /chat/completions），逐段产出文本。"""
    cfg = config.current()
    _require_chat_key(cfg)
    payload = {"model": cfg.llm_model, "messages": messages, "stream": True}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client, client.stream(
        "POST",
        f"{cfg.llm_base_url}/chat/completions",
        json=payload,
        headers=_bearer(cfg.llm_api_key),
    ) as resp:
        resp.raise_for_status()
        async for line in resp.aiter_lines():
            if not line.startswith("data:"):
                continue
            data = line[len("data:") :].strip()
            if data == "[DONE]":
                break
            try:
                delta = json.loads(data)["choices"][0].get("delta", {})
            except (json.JSONDecodeError, KeyError, IndexError):
                continue
            content = delta.get("content")
            if content:
                yield content


async def complete(
    messages: list[dict],
    max_tokens: int | None = None,
    timeout_s: float | None = None,
    model: str | None = None,
    cfg: config.EffectiveSettings | None = None,
) -> str:
    """非流式调用，用于评测、题目抽取等场景。

    `model` 可覆盖模型名；`cfg` 可指定使用哪套服务商配置——图片描述会用
    独立的视觉服务商（可能不是同一个 base_url / key），因此需要显式传入。
    """
    active = cfg or config.current()
    _require_chat_key(active)
    payload: dict = {
        "model": model or active.llm_model,
        "messages": messages,
        "stream": False,
    }
    if max_tokens:
        payload["max_tokens"] = max_tokens
    timeout = httpx.Timeout(timeout_s, connect=20.0) if timeout_s else _TIMEOUT
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            f"{active.llm_base_url}/chat/completions",
            json=payload,
            headers=_bearer(active.llm_api_key),
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]


async def embed(texts: list[str]) -> list[list[float]]:
    """调用向量模型（OpenAI 兼容 /embeddings）。"""
    cfg = config.current()
    if not cfg.embed_api_key:
        raise LLMNotConfigured(
            "未配置向量模型：请在 server/.env 中填写 EMBEDDING_API_KEY / EMBEDDING_BASE_URL / EMBEDDING_MODEL"
        )
    payload = {"model": cfg.embedding_model, "input": texts}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.post(
            f"{cfg.embed_base_url}/embeddings",
            json=payload,
            headers=_bearer(cfg.embed_api_key),
        )
        resp.raise_for_status()
        data = sorted(resp.json()["data"], key=lambda d: d["index"])
        return [d["embedding"] for d in data]
