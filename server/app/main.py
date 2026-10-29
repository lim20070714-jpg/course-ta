"""FastAPI 应用装配：CORS、BYOK 中间件、路由注册与前端静态托管。"""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from app import config, db
from app.api import chat, compute, courses, exams, graph, labs, library, problems, review
from app.core.recovery import reset_interrupted_jobs

_WEB_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init_db()
    compute.seed_formulas()
    reset_interrupted_jobs()
    yield


app = FastAPI(title="CourseTA API", version="0.21.0", lifespan=lifespan)


class BYOKMiddleware:
    """把请求头里的自带密钥挂到本次请求的上下文中（BYOK）。

    用原生 ASGI 中间件而不是 BaseHTTPMiddleware：后者会包裹响应体，
    对 SSE 流式响应不友好（可能缓冲或提前结束流）。
    """

    def __init__(self, inner) -> None:
        self.inner = inner

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.inner(scope, receive, send)
            return
        raw = {
            k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])
        }
        override = config.overrides_from_headers(raw)
        if override.is_empty:
            await self.inner(scope, receive, send)
            return
        with config.apply_overrides(override):
            await self.inner(scope, receive, send)


app.add_middleware(BYOKMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.settings.cors_origin_list,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(courses.router, prefix="/api")
app.include_router(chat.router, prefix="/api")
app.include_router(library.router, prefix="/api")
app.include_router(problems.router, prefix="/api")
app.include_router(compute.router, prefix="/api")
app.include_router(labs.router, prefix="/api")
app.include_router(graph.router, prefix="/api")
app.include_router(review.router, prefix="/api")
app.include_router(exams.router, prefix="/api")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/config")
def runtime_config() -> dict[str, object]:
    """运行时说明：服务端是否已配置密钥，以及自带密钥用哪些请求头。"""
    return config.describe_runtime()


@app.get("/api")
def api_index() -> dict[str, str]:
    return {"name": "CourseTA API", "docs": "/docs"}


if (_WEB_DIST / "index.html").is_file():
    # 构建产物在时由后端单端口托管：前端与 /api 同源，不再需要 Vite 代理
    app.mount("/assets", StaticFiles(directory=_WEB_DIST / "assets"), name="assets")

    @app.get("/", include_in_schema=False)
    def spa_index() -> FileResponse:
        return FileResponse(_WEB_DIST / "index.html")

    @app.exception_handler(404)
    async def spa_fallback(request: Request, exc: Exception) -> Response:
        """未命中路由的页面请求回落到前端。

        用 404 处理器而不是通配路由：通配路由按注册顺序匹配，会把测试或
        后续扩展在运行期追加的接口一并吞掉。
        """
        path = request.url.path.lstrip("/")
        if request.method == "GET" and not path.startswith("api"):
            candidate = _WEB_DIST / path if path else None
            if candidate is not None and candidate.is_file() and _WEB_DIST in candidate.resolve().parents:
                return FileResponse(candidate)
            return FileResponse(_WEB_DIST / "index.html")
        detail = exc.detail if isinstance(exc, StarletteHTTPException) else "Not Found"
        return JSONResponse({"detail": detail}, status_code=404)

else:

    @app.get("/")
    def root() -> dict[str, str]:
        return {"name": "CourseTA API", "docs": "/docs"}
