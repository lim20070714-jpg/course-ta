"""配置与按请求覆盖（BYOK：自带密钥）。

默认从 `.env` 读取服务端配置。开源部署时，访问者可以带上自己的密钥，
由请求头覆盖本次请求使用的 key / base_url / 模型——这样多人共用一个实例时
不会消耗部署者的额度，也不需要把密钥写进服务端 `.env`。

覆盖通过 `contextvar` 实现，天然按请求隔离（SSE 流式响应期间也保持一致），
请求结束后自动失效。
"""

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    data_dir: Path = Path("data")

    llm_api_key: str = ""
    llm_base_url: str = "https://api.deepseek.com/v1"
    llm_model: str = "deepseek-chat"
    extract_model: str = ""  # 题目抽取可单独指定更强的模型；留空则用 llm_model
    vision_model: str = ""  # 图片描述专用视觉模型；留空则跳过图片描述（不影响上传与查看）
    # 视觉模型可以来自与对话模型不同的服务商（例如对话用 Qwen、图片理解用 DeepSeek）
    vision_key: str = ""  # 留空则复用 LLM_API_KEY
    vision_base: str = ""  # 留空则复用 LLM_BASE_URL

    embedding_api_key: str = ""
    embedding_base_url: str = ""
    embedding_model: str = "text-embedding-v3"

    top_k: int = 6
    chunk_size: int = 500
    chunk_overlap: int = 80

    # 检索方式：auto（默认，向量优先、失败降级）/ vector（只用向量，失败即报错）
    # / keyword（只用词频，不调向量模型，适合没有 embeddings 额度的部署）
    retrieval_mode: str = "auto"

    # 允许访问 API 的前端来源，逗号分隔。开源部署时改成自己的域名，例如
    # CORS_ORIGINS=https://course.example.com,http://localhost:5173
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    @property
    def cors_origin_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]

    @property
    def problem_model(self) -> str:
        return self.extract_model or self.llm_model

    @property
    def embed_base_url(self) -> str:
        return self.embedding_base_url or self.llm_base_url

    @property
    def embed_api_key(self) -> str:
        return self.embedding_api_key or self.llm_api_key


settings = Settings()


@dataclass(frozen=True)
class RequestOverrides:
    """单次请求生效的覆盖值；None 表示该项沿用服务端配置。"""

    llm_api_key: str | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None
    embed_api_key: str | None = None
    embed_base_url: str | None = None
    embed_model: str | None = None
    vision_model: str | None = None
    vision_base_url: str | None = None
    from_client: bool = False  # 该请求是否携带了自己的密钥

    @property
    def is_empty(self) -> bool:
        return not any(
            (
                self.llm_api_key,
                self.llm_base_url,
                self.llm_model,
                self.embed_api_key,
                self.embed_base_url,
                self.embed_model,
                self.vision_model,
                self.vision_base_url,
            )
        )


# 默认 None 而不是 RequestOverrides()：避免可变默认值在请求之间共享
_active: ContextVar[RequestOverrides | None] = ContextVar("request_overrides", default=None)


class EffectiveSettings:
    """把服务端配置与本次请求覆盖合并后的只读视图。

    用法与 `Settings` 相同（`current().llm_api_key`），因此调用方无需改动。
    """

    def __init__(self, base: Settings, override: RequestOverrides) -> None:
        self._base = base
        self._o = override

    # ---- 原始项：有覆盖先用覆盖 ----
    @property
    def data_dir(self) -> Path:
        return self._base.data_dir

    @property
    def llm_api_key(self) -> str:
        return self._o.llm_api_key or self._base.llm_api_key

    @property
    def llm_base_url(self) -> str:
        return (self._o.llm_base_url or self._base.llm_base_url).rstrip("/")

    @property
    def llm_model(self) -> str:
        return self._o.llm_model or self._base.llm_model

    @property
    def extract_model(self) -> str:
        # 访问者用自己的密钥时，不应把服务端为「抽取」单独配置的模型套用过去
        if self._o.from_client:
            return ""
        return self._base.extract_model

    @property
    def vision_model(self) -> str:
        return self._o.vision_model or self._base.vision_model

    @property
    def embedding_api_key(self) -> str:
        # 访问者可单独提供向量密钥（对话服务商不支持 embeddings 时必需）；
        # 否则回退到自带/服务端的对话密钥
        return self._o.embed_api_key or self._base.embedding_api_key or self.llm_api_key

    @property
    def embedding_base_url(self) -> str:
        return self._o.embed_base_url or self._base.embedding_base_url or self.llm_base_url

    @property
    def embedding_model(self) -> str:
        return self._o.embed_model or self._base.embedding_model

    # ---- 派生项：与 Settings 保持同样的解析规则 ----
    @property
    def problem_model(self) -> str:
        return self.extract_model or self.llm_model

    @property
    def embed_base_url(self) -> str:
        return self.embedding_base_url or self.llm_base_url

    @property
    def embed_api_key(self) -> str:
        return self.embedding_api_key or self.llm_api_key

    @property
    def vision_base_url(self) -> str:
        # 覆盖优先（BYOK）→ 独立的视觉服务商 → 回退到对话服务商
        return (self._o.vision_base_url or self._base.vision_base or self.llm_base_url).rstrip("/")

    @property
    def vision_api_key(self) -> str:
        return self._o.llm_api_key or self._base.vision_key or self._base.llm_api_key

    # ---- 其余标量配置直接透传 ----
    @property
    def top_k(self) -> int:
        return self._base.top_k

    @property
    def chunk_size(self) -> int:
        return self._base.chunk_size

    @property
    def chunk_overlap(self) -> int:
        return self._base.chunk_overlap

    @property
    def has_client_key(self) -> bool:
        return bool(self._o.llm_api_key)


def current() -> EffectiveSettings:
    """当前请求生效的配置（含客户端覆盖）。"""
    return EffectiveSettings(settings, _active.get() or RequestOverrides())


def vision_config() -> Settings:
    """图片描述专用配置。

    视觉模型可以来自与对话模型不同的服务商：优先用 `VISION_KEY` / `VISION_BASE`
    （留空则复用 `LLM_*`），再把 llm_* 指向该服务商，这样 `llm.complete()` 走对端点。
    """
    active = current()
    # Settings 是 pydantic 模型（非 dataclass），用 model_copy 生成指向视觉服务商的副本
    return settings.model_copy(
        update={
            "llm_base_url": active.vision_base_url,
            "llm_api_key": active.vision_api_key,
            "llm_model": active.vision_model,
        }
    )


@contextmanager
def apply_overrides(override: RequestOverrides) -> Iterator[None]:
    """在 with 块内让 `current()` 返回被覆盖后的配置；退出时自动还原。"""
    token = _active.set(override)
    try:
        yield
    finally:
        _active.reset(token)


# ---- 请求头 → 覆盖值 ----

HEADER_KEY = "x-llm-api-key"
HEADER_BASE_URL = "x-llm-base-url"
HEADER_MODEL = "x-llm-model"
HEADER_EMBED_KEY = "x-embedding-api-key"
HEADER_EMBED_BASE_URL = "x-embedding-base-url"
HEADER_EMBED_MODEL = "x-embedding-model"
HEADER_VISION_MODEL = "x-vision-model"
HEADER_VISION_BASE_URL = "x-vision-base-url"

# 允许的最大长度，防止把超长字符串塞进请求头
_MAX_HEADER = 300


def overrides_from_headers(headers: dict[str, str]) -> RequestOverrides:
    """从请求头解析出覆盖值；未提供或空白一律视为沿用服务端配置。"""

    def take(name: str) -> str | None:
        raw = headers.get(name)
        if raw is None:
            return None
        value = raw.strip()
        if not value or len(value) > _MAX_HEADER:
            return None
        return value

    key = take(HEADER_KEY)
    embed_key = take(HEADER_EMBED_KEY)
    return RequestOverrides(
        llm_api_key=key,
        llm_base_url=take(HEADER_BASE_URL),
        llm_model=take(HEADER_MODEL),
        embed_api_key=embed_key,
        embed_base_url=take(HEADER_EMBED_BASE_URL),
        embed_model=take(HEADER_EMBED_MODEL),
        vision_model=take(HEADER_VISION_MODEL),
        vision_base_url=take(HEADER_VISION_BASE_URL),
        from_client=key is not None or embed_key is not None,
    )


def describe_runtime() -> dict[str, object]:
    """给前端用的运行时说明：服务端是否已配置密钥、允许哪些覆盖。

    只报告「有没有」与头名，绝不回显密钥本身。
    """
    return {
        "server_key_configured": bool(settings.llm_api_key),
        # 向量额度可能单独托管：只配 EMBEDDING_API_KEY 时，材料解析仍可用
        "server_embedding_configured": bool(settings.embedding_api_key or settings.llm_api_key),
        "server_model": settings.llm_model,
        "server_base_url": settings.llm_base_url,
        "server_vision_model": settings.vision_model,
        # 视觉模型是否与对话模型来自不同服务商（只报告事实，不含密钥）
        "vision_base_url": settings.vision_base or settings.llm_base_url,
        "vision_separate_provider": bool(settings.vision_base),
        "byok_headers": {
            "key": HEADER_KEY,
            "base_url": HEADER_BASE_URL,
            "model": HEADER_MODEL,
            "embedding_key": HEADER_EMBED_KEY,
            "embedding_base_url": HEADER_EMBED_BASE_URL,
            "embedding_model": HEADER_EMBED_MODEL,
            "vision_model": HEADER_VISION_MODEL,
            "vision_base_url": HEADER_VISION_BASE_URL,
        },
    }
