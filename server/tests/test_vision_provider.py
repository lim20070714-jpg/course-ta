"""视觉模型可以来自与对话模型不同的服务商（如对话 Qwen + 图片理解 DeepSeek）。

这是本次改动的核心承诺：`VISION_MODEL` / `VISION_BASE` / `VISION_KEY` 三者
能独立指向另一个服务商，而对话链路完全不受影响；不配置时一切回退到 `LLM_*`。
"""

from pathlib import Path

import pytest

from app import config
from app.core import media

PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00"
    b"\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\xcf\xc0\x00\x00\x03\x01\x01\x00\x18\xdd\x8d\xb0"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)


@pytest.fixture(autouse=True)
def _restore_settings(monkeypatch: pytest.MonkeyPatch):
    """每个用例独立设置视觉配置，用完自动还原。"""
    monkeypatch.setattr(config.settings, "vision_model", "")
    monkeypatch.setattr(config.settings, "vision_base", "")
    monkeypatch.setattr(config.settings, "vision_key", "")
    yield


def _use_deepseek_vision(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config.settings, "vision_model", "deepseek-flash")
    monkeypatch.setattr(config.settings, "vision_base", "https://api.deepseek.com/v1")
    monkeypatch.setattr(config.settings, "vision_key", "sk-deepseek-fake")


# ---------------------------------------------------------------- 配置解析


def test_vision_falls_back_to_chat_provider_when_unset() -> None:
    vc = config.vision_config()
    assert vc.llm_base_url == config.settings.llm_base_url.rstrip("/")
    assert vc.llm_api_key == config.settings.llm_api_key
    assert vc.llm_model == ""  # 未启用视觉：模型名为空，调用方据此跳过
    assert config.describe_runtime()["vision_separate_provider"] is False


def test_vision_provider_can_differ_from_chat(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_deepseek_vision(monkeypatch)
    vc = config.vision_config()
    assert vc.llm_base_url == "https://api.deepseek.com/v1"
    assert vc.llm_api_key == "sk-deepseek-fake"
    assert vc.llm_model == "deepseek-flash"
    # 对话链路完全不受影响
    assert config.current().llm_base_url == config.settings.llm_base_url.rstrip("/")
    assert config.current().llm_api_key == config.settings.llm_api_key
    info = config.describe_runtime()
    assert info["vision_separate_provider"] is True
    assert info["vision_base_url"] == "https://api.deepseek.com/v1"


def test_vision_key_falls_back_to_chat_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config.settings, "vision_model", "some-vl")
    monkeypatch.setattr(config.settings, "vision_base", "https://other.example.com/v1")
    # 不填 VISION_KEY：复用对话密钥
    vc = config.vision_config()
    assert vc.llm_api_key == config.settings.llm_api_key
    assert vc.llm_base_url == "https://other.example.com/v1"


def test_byok_visitor_can_override_vision_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_deepseek_vision(monkeypatch)
    with config.apply_overrides(
        config.RequestOverrides(
            llm_api_key="sk-visitor",
            vision_base_url="https://visitor.example.com/v1",
            vision_model="visitor-vl",
            from_client=True,
        )
    ):
        vc = config.vision_config()
        assert vc.llm_base_url == "https://visitor.example.com/v1"
        assert vc.llm_api_key == "sk-visitor"
        assert vc.llm_model == "visitor-vl"


# ---------------------------------------------------------------- 调用行为


@pytest.mark.anyio
async def test_describe_image_skipped_without_vision_model(tmp_path: Path) -> None:
    png = tmp_path / "a.png"
    png.write_bytes(PNG)
    assert await media.describe_image(png) == ""


@pytest.mark.anyio
async def test_describe_image_uses_vision_provider(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _use_deepseek_vision(monkeypatch)
    png = tmp_path / "电路图.png"
    png.write_bytes(PNG)

    captured: dict[str, object] = {}

    async def fake_complete(messages, max_tokens=None, timeout_s=None, model=None, cfg=None):
        captured["model"] = model
        captured["cfg"] = cfg
        return "图中是一个电阻分压电路"

    monkeypatch.setattr(media.llm, "complete", fake_complete)
    text = await media.describe_image(png)

    assert text == "图中是一个电阻分压电路"
    assert captured["model"] == "deepseek-flash"
    cfg = captured["cfg"]
    assert cfg.llm_base_url == "https://api.deepseek.com/v1"
    assert cfg.llm_api_key == "sk-deepseek-fake"


@pytest.mark.anyio
async def test_describe_image_sends_openai_image_block(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """DeepSeek 文档要求 content 为块数组、图片走 image_url + data URL。"""
    _use_deepseek_vision(monkeypatch)
    png = tmp_path / "b.png"
    png.write_bytes(PNG)

    seen: dict[str, object] = {}

    async def fake_complete(messages, max_tokens=None, timeout_s=None, model=None, cfg=None):
        seen["messages"] = messages
        return "ok"

    monkeypatch.setattr(media.llm, "complete", fake_complete)
    await media.describe_image(png)

    messages = seen["messages"]
    blocks = messages[0]["content"]
    assert isinstance(blocks, list)
    assert blocks[0]["type"] == "text"
    assert blocks[1]["type"] == "image_url"
    assert blocks[1]["image_url"]["url"].startswith("data:image/png;base64,")
    # 图片只能出现在 user 消息里（DeepSeek 对 system/assistant 带图返回 400）
    assert messages[0]["role"] == "user"


@pytest.mark.anyio
async def test_describe_image_failure_is_reported_not_raised(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """描述失败不能影响图片入库，只把原因写进文本。"""
    _use_deepseek_vision(monkeypatch)
    png = tmp_path / "c.png"
    png.write_bytes(PNG)

    async def boom(messages, max_tokens=None, timeout_s=None, model=None, cfg=None):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(media.llm, "complete", boom)
    text = await media.describe_image(png)
    assert "图片描述失败" in text
    assert "RuntimeError" in text
