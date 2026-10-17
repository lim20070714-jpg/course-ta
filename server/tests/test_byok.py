"""自带密钥（BYOK）：请求级密钥覆盖、隔离性与不泄漏服务端密钥。

开源部署的关键行为：访问者可以带自己的密钥，多人共用一个实例时不消耗部署者额度；
未携带密钥时完全回退到服务端配置；无论哪种情况，接口都不得把服务端密钥回显出去。
"""

import asyncio
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

import app.db as db_module
from app import config
from app.config import (
    HEADER_BASE_URL,
    HEADER_KEY,
    HEADER_MODEL,
    HEADER_VISION_MODEL,
    RequestOverrides,
    apply_overrides,
    describe_runtime,
    overrides_from_headers,
)
from app.main import BYOKMiddleware, app
from app.models import Course

# ---------------------------------------------------------------- 请求头解析


def test_overrides_from_headers_empty() -> None:
    o = overrides_from_headers({})
    assert o.is_empty and o.llm_api_key is None and not o.from_client


def test_overrides_from_headers_parses_all() -> None:
    o = overrides_from_headers(
        {
            HEADER_KEY: "sk-visitor-123",
            HEADER_BASE_URL: "https://api.example.com/v1",
            HEADER_MODEL: "my-model",
            HEADER_VISION_MODEL: "my-vl",
        }
    )
    assert o.llm_api_key == "sk-visitor-123"
    assert o.llm_base_url == "https://api.example.com/v1"
    assert o.llm_model == "my-model"
    assert o.vision_model == "my-vl"
    assert o.from_client is True


def test_overrides_ignores_blank_and_oversized() -> None:
    assert overrides_from_headers({HEADER_KEY: "   "}).is_empty
    assert overrides_from_headers({HEADER_KEY: "x" * 500}).is_empty
    # 有 base_url 但没 key：不算「自带密钥」，但 base_url 覆盖仍生效
    o = overrides_from_headers({HEADER_BASE_URL: "http://localhost:11434/v1"})
    assert o.from_client is False
    assert o.llm_base_url == "http://localhost:11434/v1"


# ---------------------------------------------------------------- 合并规则


def test_current_falls_back_to_server_config() -> None:
    cfg = config.current()
    assert cfg.llm_api_key == config.settings.llm_api_key
    assert cfg.llm_model == config.settings.llm_model


def test_current_prefers_client_values() -> None:
    with apply_overrides(
        RequestOverrides(llm_api_key="sk-visitor", llm_model="visitor-model", from_client=True)
    ):
        cfg = config.current()
        assert cfg.llm_api_key == "sk-visitor"
        assert cfg.llm_model == "visitor-model"
        # 未覆盖的项仍来自服务端
        assert cfg.llm_base_url == config.settings.llm_base_url.rstrip("/")
        assert cfg.has_client_key is True
    # 退出上下文后完全还原
    assert config.current().llm_api_key == config.settings.llm_api_key
    assert config.current().has_client_key is False


def test_client_key_does_not_inherit_server_extract_model() -> None:
    server_extract = config.settings.extract_model
    if not server_extract:
        pytest.skip("服务端未配置 EXTRACT_MODEL，该分支无差异")
    with apply_overrides(RequestOverrides(llm_api_key="sk-v", from_client=True)):
        assert config.current().extract_model == ""
        assert config.current().problem_model == config.current().llm_model


def test_effective_embedding_key_falls_back_to_llm_key() -> None:
    with apply_overrides(RequestOverrides(llm_api_key="sk-visitor", from_client=True)):
        assert config.current().embed_api_key == "sk-visitor"  # 自带密钥同样用于向量模型
    with apply_overrides(RequestOverrides()):
        assert config.current().embed_api_key == config.settings.llm_api_key


def test_effective_base_url_strips_trailing_slash() -> None:
    with apply_overrides(RequestOverrides(llm_base_url="https://api.example.com/v1/")):
        assert config.current().llm_base_url == "https://api.example.com/v1"


def test_overrides_are_isolated_between_threads() -> None:
    """contextvar 隔离：一个线程的覆盖不会影响另一个线程。"""
    seen: dict[str, str] = {}

    def with_key() -> None:
        with apply_overrides(RequestOverrides(llm_api_key="sk-thread", from_client=True)):
            time.sleep(0.05)
            seen["thread"] = config.current().llm_api_key

    def without_key() -> None:
        time.sleep(0.02)
        seen["plain"] = config.current().llm_api_key

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(with_key), pool.submit(without_key)]
        for f in futures:
            f.result()

    assert seen["thread"] == "sk-thread"
    assert seen["plain"] == config.settings.llm_api_key


# ---------------------------------------------------------------- 中间件行为


@pytest.fixture(name="probe_client")
def probe_client_fixture() -> TestClient:
    """最小应用：只挂 BYOK 中间件，避免依赖数据库与业务路由。"""
    probe = FastAPI()
    probe.add_middleware(BYOKMiddleware)

    @probe.get("/whoami")
    def whoami() -> dict[str, object]:
        cfg = config.current()
        return {
            "key_is_server": cfg.llm_api_key == config.settings.llm_api_key,
            "model": cfg.llm_model,
            "base_url": cfg.llm_base_url,
            "has_client_key": cfg.has_client_key,
        }

    return TestClient(probe)


def test_middleware_applies_header_overrides(probe_client: TestClient) -> None:
    body = probe_client.get(
        "/whoami",
        headers={HEADER_KEY: "sk-visitor", HEADER_MODEL: "visitor-model"},
    ).json()
    assert body["has_client_key"] is True
    assert body["key_is_server"] is False
    assert body["model"] == "visitor-model"


def test_middleware_falls_back_without_header(probe_client: TestClient) -> None:
    body = probe_client.get("/whoami").json()
    assert body["key_is_server"] is True
    assert body["has_client_key"] is False
    assert body["model"] == config.settings.llm_model


def test_middleware_does_not_leak_between_requests(probe_client: TestClient) -> None:
    """带密钥的请求之后，下一个不带密钥的请求必须回到服务端配置。"""
    probe_client.get("/whoami", headers={HEADER_KEY: "sk-visitor"})
    body = probe_client.get("/whoami").json()
    assert body["key_is_server"] is True
    assert body["has_client_key"] is False


def test_middleware_ignores_blank_key_header(probe_client: TestClient) -> None:
    body = probe_client.get("/whoami", headers={HEADER_KEY: "   "}).json()
    assert body["key_is_server"] is True


# ---------------------------------------------------------------- 接口行为


@pytest.fixture(name="client")
def client_fixture(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(db_module, "engine", engine)
    with Session(engine) as session:
        session.add(Course(id=1, name="电路", created_at=datetime.now(UTC)))
        session.commit()
    return TestClient(app)


def test_config_endpoint_describes_byok_without_leaking_key(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 用哨兵密钥，避免依赖运行测试机器的 .env 是否配置
    monkeypatch.setattr(config.settings, "llm_api_key", "sk-server-secret-xyz")
    resp = client.get("/api/config")
    assert resp.status_code == 200
    body = resp.json()
    assert body["server_key_configured"] is True
    assert body["byok_headers"]["key"] == HEADER_KEY
    # 绝不回显服务端密钥本身
    assert "sk-server-secret-xyz" not in json.dumps(body)


def test_config_endpoint_reports_when_server_has_no_key(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(config.settings, "llm_api_key", "")
    assert client.get("/api/config").json()["server_key_configured"] is False


def test_describe_runtime_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config.settings, "llm_api_key", "sk-server-secret-xyz")
    info = describe_runtime()
    assert set(info) >= {"server_key_configured", "server_model", "server_base_url", "byok_headers"}
    assert "sk-server-secret-xyz" not in json.dumps(info)


def test_real_app_applies_header_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    """在真实 app 上挂一个探针路由，确认 BYOK 中间件已正确装配。"""

    @app.get("/api/_byok_probe")
    def _probe() -> dict[str, object]:
        cfg = config.current()
        return {
            "is_server_key": cfg.llm_api_key == config.settings.llm_api_key,
            "model": cfg.llm_model,
        }

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(db_module, "engine", engine)
    client = TestClient(app)

    try:
        with_header = client.get(
            "/api/_byok_probe",
            headers={HEADER_KEY: "sk-visitor-abc", HEADER_MODEL: "visitor-model"},
        ).json()
        assert with_header["is_server_key"] is False
        assert with_header["model"] == "visitor-model"

        without_header = client.get("/api/_byok_probe").json()
        assert without_header["is_server_key"] is True
        assert without_header["model"] == config.settings.llm_model
    finally:
        app.router.routes = [
            r for r in app.router.routes if getattr(r, "path", "") != "/api/_byok_probe"
        ]


def test_llm_uses_active_override_within_request(monkeypatch: pytest.MonkeyPatch) -> None:
    """在覆盖上下文内调用 llm，应使用覆盖值（等价于请求处理期间）。"""
    captured: dict[str, str] = {}

    async def fake_complete(messages, max_tokens=None, timeout_s=None, model=None):
        captured["key"] = config.current().llm_api_key
        captured["model"] = config.current().llm_model
        return "ok"

    monkeypatch.setattr("app.core.llm.complete", fake_complete)
    from app.core import llm

    with apply_overrides(
        RequestOverrides(llm_api_key="sk-visitor-abc", llm_model="visitor-model", from_client=True)
    ):
        asyncio.run(llm.complete([{"role": "user", "content": "hi"}]))
    assert captured["key"] == "sk-visitor-abc"
    assert captured["model"] == "visitor-model"
