import json
from collections.abc import AsyncIterator

import httpx

from app.config import settings

_TIMEOUT = httpx.Timeout(120.0, connect=20.0)


class LLMNotConfigured(RuntimeError):
    pass


def _bearer(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"} if key else {}


def _require_chat_key() -> None:
    if settings.llm_api_key:
        return
    if "localhost" in settings.llm_base_url or "127.0.0.1" in settings.llm_base_url:
        return  # 本地模型（如 Ollama）通常不需要 key
    raise LLMNotConfigured("未配置 LLM_API_KEY，请在 server/.env 中填写（参考 .env.example）")


async def chat_stream(messages: list[dict]) -> AsyncIterator[str]:
    """流式调用对话模型（OpenAI 兼容 /chat/completions），逐段产出文本。"""
    _require_chat_key()
    payload = {"model": settings.llm_model, "messages": messages, "stream": True}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client, client.stream(
        "POST",
        f"{settings.llm_base_url}/chat/completions",
        json=payload,
        headers=_bearer(settings.llm_api_key),
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


async def complete(messages: list[dict]) -> str:
    """非流式调用，用于评测等场景。"""
    _require_chat_key()
    payload = {"model": settings.llm_model, "messages": messages, "stream": False}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.post(
            f"{settings.llm_base_url}/chat/completions",
            json=payload,
            headers=_bearer(settings.llm_api_key),
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]


async def embed(texts: list[str]) -> list[list[float]]:
    """调用向量模型（OpenAI 兼容 /embeddings）。"""
    if not settings.embed_api_key:
        raise LLMNotConfigured(
            "未配置向量模型：请在 server/.env 中填写 EMBEDDING_API_KEY / EMBEDDING_BASE_URL / EMBEDDING_MODEL"
        )
    payload = {"model": settings.embedding_model, "input": texts}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.post(
            f"{settings.embed_base_url}/embeddings",
            json=payload,
            headers=_bearer(settings.embed_api_key),
        )
        resp.raise_for_status()
        data = sorted(resp.json()["data"], key=lambda d: d["index"])
        return [d["embedding"] for d in data]
