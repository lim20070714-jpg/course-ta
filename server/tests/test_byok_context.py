"""关键安全性检查：BYOK 覆盖是否传到 BackgroundTasks / SSE 生成器里。

如果覆盖在后台任务中丢失，访问者上传大文件时就会静默消耗部署者的额度——
这正是 BYOK 要避免的事，必须显式验证。
"""

from fastapi import BackgroundTasks, FastAPI
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from app import config
from app.config import HEADER_KEY
from app.main import BYOKMiddleware


def build_probe() -> tuple[FastAPI, dict[str, str]]:
    seen: dict[str, str] = {}
    probe = FastAPI()
    probe.add_middleware(BYOKMiddleware)

    def worker() -> None:
        # 模拟 ingest / graph 这类后台任务里读取配置
        seen["background"] = config.current().llm_api_key

    @probe.post("/job")
    def job(background: BackgroundTasks) -> dict[str, str]:
        seen["request"] = config.current().llm_api_key
        background.add_task(worker)
        return {"ok": "1"}

    async def streamer():
        # 模拟 SSE：生成器在请求上下文内产出
        seen["stream"] = config.current().llm_api_key
        yield b"data: done\n\n"

    @probe.get("/stream")
    def stream() -> StreamingResponse:
        return StreamingResponse(streamer(), media_type="text/event-stream")

    return probe, seen


def test_byok_context_reaches_background_tasks() -> None:
    probe, seen = build_probe()
    client = TestClient(probe)
    resp = client.post("/job", headers={HEADER_KEY: "sk-visitor"})
    assert resp.status_code == 200
    assert seen["request"] == "sk-visitor"
    # 关键断言：后台任务里读到的必须是访问者的密钥，而不是服务端密钥
    assert seen["background"] == "sk-visitor", (
        "BYOK 覆盖没有传到 BackgroundTasks —— 访问者的上传会消耗部署者额度"
    )


def test_byok_context_reaches_streaming_generator() -> None:
    probe, seen = build_probe()
    client = TestClient(probe)
    with client.stream("GET", "/stream", headers={HEADER_KEY: "sk-visitor"}) as resp:
        assert resp.status_code == 200
        list(resp.iter_lines())
    assert seen["stream"] == "sk-visitor"


def test_without_header_background_uses_server_key() -> None:
    probe, seen = build_probe()
    client = TestClient(probe)
    client.post("/job")
    assert seen["background"] == config.settings.llm_api_key


def test_streaming_without_header_uses_server_key() -> None:
    probe, seen = build_probe()
    client = TestClient(probe)
    with client.stream("GET", "/stream") as resp:
        list(resp.iter_lines())
    assert seen["stream"] == config.settings.llm_api_key


def test_background_task_override_does_not_leak_to_next_request() -> None:
    probe, seen = build_probe()
    client = TestClient(probe)
    client.post("/job", headers={HEADER_KEY: "sk-visitor"})
    client.post("/job")
    assert seen["background"] == config.settings.llm_api_key
