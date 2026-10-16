# CourseTA 后端镜像：FastAPI + SQLModel(SQLite) + uv
#
# 构建上下文是 server/（见根目录 docker-compose.yml 的 context: ./server）。
# 只复制 app/ 与 scripts/：.env 与 data/ 绝不进镜像——
#   * .env     → 运行时由 docker-compose 的 env_file 注入；
#   * data/    → 运行时挂载命名卷到 /app/data（数据库与上传材料是唯一持久化数据）。

FROM python:3.12-slim

# uv：版本与生成 server/uv.lock 的版本保持一致，保证 `uv sync --frozen` 可复现。
# （如需换成官方镜像，可改为：
#   COPY --from=ghcr.io/astral-sh/uv:0.12.20 /uv /uvx /bin/
#  并删掉下面的 RUN pip install。）
RUN pip install --no-cache-dir uv==0.12.20

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=0 \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    PATH="/app/.venv/bin:$PATH" \
    DATA_DIR=/app/data

WORKDIR /app

# 先只装依赖：之后改 app/ 里的代码不会让依赖层缓存失效
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY app ./app
COPY scripts ./scripts

# 卷挂载点；不挂载时也能直接用容器内目录
RUN mkdir -p /app/data

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health').read()"

# 容器里必须监听 0.0.0.0，否则端口映射后宿主机访问不到
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
