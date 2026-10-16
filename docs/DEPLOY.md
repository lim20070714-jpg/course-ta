# CourseTA 自托管部署指南

CourseTA 是一个「带出处引用的课程 AI 助教」：上传课件/教材/试题后可以问答、检索、抽题、批改、
做知识图谱和复习计划。本文档覆盖三种自托管路径，以及**密钥与费用**、**数据备份**、**安全**。

## 0. 三条路径怎么选

| | 路径 A：本机自用 | 路径 B：局域网/公网共享实例 | 路径 C：只用 API 接自己的前端 |
| --- | --- | --- | --- |
| 面向 | 只有自己用 | 多人访问同一个网址 | 你有自己的前端/脚本 |
| 启动方式 | `uv run uvicorn` + `npm run dev` | `docker compose up -d --build` | Docker（只跑 api）或 uv |
| 谁出 token | 你自己 | **访问者自带密钥（BYOK）**，见 §3 | 取决于你的前端 |
| 需要 `CORS_ORIGINS` | 默认值已覆盖（无需改） | 同源部署不需要；API 单独暴露时必须设 | **必须设成你前端的 Origin** |
| HTTPS | 不需要（localhost） | 建议（反向代理 + 证书） | 建议 |
| 数据位置 | `server/data/` | 命名卷 `course-ta-data`（挂在 `/app/data`） | `server/data/` 或卷 |

接口细节见 [API.md](API.md)。

---

## 1. 路径 A：本机自用（uv + npm dev）

```powershell
# 后端
cd server
uv sync
Copy-Item .env.example .env     # 填入 LLM_API_KEY / EMBEDDING_*（见 §3）
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000

# 前端（另开一个终端）
cd web
npm install
npm run dev                     # Vite 监听 5173，并把 /api 代理到 http://localhost:8000
```

打开 <http://localhost:5173>。API 文档在 <http://127.0.0.1:8000/docs>。

- 这条路径下浏览器访问的是 `5173`、API 在 `8000`，属于**跨域**，靠后端默认的
  `CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173` 放行，**无需改动**。
- 只想要一个单机静态页面：`cd web && npm run build`，把 `web/dist/` 交给任意静态服务器，
  并让它把 `/api` 反代到 `127.0.0.1:8000`（参考 `web/nginx.conf`）。

---

## 2. 路径 B：局域网/公网（Docker Compose + 反向代理/HTTPS）

### 2.1 前置条件

- Docker Engine 24+ 与 Docker Compose v2（`docker --version`、`docker compose version`）
- Compose ≥ 2.24（`docker-compose.yml` 用了 `env_file: {path, required}` 写法；
  老版本请把 `env_file` 改成 `env_file: [./server/.env]` 并确保该文件存在）
- 服务器上 8080 端口空闲（可改）

### 2.2 部署步骤（这就是完整的启动流程）

```bash
git clone <你的仓库地址> course-ta
cd course-ta

# 1) 准备服务端配置（必做：至少确认 CORS_ORIGINS）
cp server/.env.example server/.env
vi server/.env

# 2) 构建并启动两个服务
docker compose up -d --build

# 3) 看状态与日志
docker compose ps
docker compose logs -f api

# 4) 打开页面（8080 是唯一对外端口：页面 + /api + /docs 都走它）
#    http://<服务器IP>:8080
#    http://<服务器IP>:8080/docs
```

常用运维命令：

```bash
docker compose restart api          # 只重启后端（改了 server/.env 后需要重启才生效）
docker compose up -d --build        # 更新代码后重建（数据在卷里，不会丢）
docker compose logs -f web          # nginx 日志
docker compose down                 # 停止并删除容器（保留卷）
docker compose down -v              # ⚠️ 连数据卷一起删，等于清空所有课程数据，慎用
```

镜像与服务：

| 服务 | Dockerfile | 说明 | 端口 |
| --- | --- | --- | --- |
| `api` | `server/Dockerfile` | Python 3.12 + uv，`uvicorn app.main:app --host 0.0.0.0 --port 8000` | 容器 8000；compose 里只绑到 `127.0.0.1:8000` 方便本机调试 |
| `web` | `web/Dockerfile` | Node 24 build → nginx 托管 `dist/`，并把 `/api`、`/docs`、`/redoc`、`/openapi.json` 反代到 `api` | `8080:80` |

`web/nginx.conf` 已经处理了两件容易踩坑的事：

1. **SSE 不被缓冲**：`/api` 上设了 `proxy_buffering off`，`proxy_read_timeout 3600s`
   ——AI 生成答案/批改可以持续几分钟，默认 60s 会 504，开启缓冲则会「不流式」。
2. **上传体积**：`client_max_body_size 512m`（nginx 默认 1m，课件/试卷一上传就 413）。

### 2.3 为什么必须关注 `CORS_ORIGINS`

`CORS_ORIGINS` 是后端允许的**浏览器来源**列表，逗号分隔，默认
`http://localhost:5173,http://127.0.0.1:5173`。

- 浏览器有同源策略：页面在 `https://a.com`、API 在 `https://b.com`（或不同端口）时，
  浏览器会先发 CORS 预检，后端没把 `a.com` 列进 `CORS_ORIGINS` 就直接拦掉请求
  （现象：控制台报 `blocked by CORS policy`，请求根本没到业务代码）。
- **路径 B 是同源部署**（nginx 把 `/api` 反代到自己，浏览器只与 8080 通信），所以「不需要为它配 CORS」。
- 但只要出现下面任一情况，就**必须**把真实 Origin 写进 `CORS_ORIGINS`：
  - 把 API 端口直接暴露给浏览器（如前端 `https://course.example.com` 调 `https://api.example.com`）；
  - 前端单独部署在别的域名/端口；
  - 用 `http://<服务器IP>:8080` 之外的自定义域名/端口访问 API。

写法（在 `server/.env`）：

```ini
CORS_ORIGINS=https://course.example.com,http://localhost:5173
```

注意：Origin 只写 `协议://主机[:端口]`，**不要带路径和结尾斜杠**；写错等于没放行。
改完要 `docker compose restart api`。

### 2.4 加一层反向代理 + HTTPS（推荐）

把域名解析到服务器，外面再套一层 TLS 终止，转发到 `127.0.0.1:8080`。

**Caddy（自动申请证书，最省事）**：

```caddyfile
course.example.com {
    reverse_proxy 127.0.0.1:8080 {
        flush_interval -1      # 立即刷新：SSE 必须，否则答案会攒到最后一次性出现
    }
}
```

**nginx + certbot**：

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name course.example.com;

    ssl_certificate     /etc/letsencrypt/live/course.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/course.example.com/privkey.pem;

    client_max_body_size 512m;          # 外层代理同样要放宽，否则先于内层被 413

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        proxy_buffering off;            # SSE 关键
        proxy_read_timeout 3600s;       # 长回答
        proxy_send_timeout 3600s;
    }
}
```

> 换了域名/端口后，记得同步更新 `CORS_ORIGINS`（只在「浏览器直连 API」时才需要）。

---

## 3. 密钥与费用（谁出 token）

AI 能力（问答、批改、详解、题目抽取、总结、图谱、图片描述、向量化）都调用 **OpenAI 兼容接口**，
费用由「这次请求用的密钥」承担。三条路径的区别就在这里：

| 路径 | 谁付 token | 怎么配置 |
| --- | --- | --- |
| A 本机自用 | 你自己 | `server/.env` 里填 `LLM_API_KEY` / `EMBEDDING_*` |
| B 共享实例 | **访问者自己**（BYOK） | `server/.env` 里把 `LLM_API_KEY` **留空**，访问者在页面里填自己的密钥 |
| C 只用 API | 看你给出去的是谁的 key | 客户端按需发送 BYOK 请求头 |

### 3.1 BYOK（自带密钥）是什么

访问者可以在请求头里带上自己的密钥，后端**按请求**使用它，请求结束即失效：
不会写进数据库、不会写进日志、不影响其他人。这样一台多人共用的实例不会烧掉部署者的额度。

| 请求头 | 覆盖的配置 |
| --- | --- |
| `X-LLM-API-Key` | `LLM_API_KEY` |
| `X-LLM-Base-URL` | `LLM_BASE_URL` |
| `X-LLM-Model` | `LLM_MODEL` |
| `X-Embedding-API-Key` | `EMBEDDING_API_KEY` |
| `X-Embedding-Base-URL` | `EMBEDDING_BASE_URL` |
| `X-Embedding-Model` | `EMBEDDING_MODEL` |
| `X-Vision-Model` | `VISION_MODEL` |
| `X-Vision-Base-URL` | `VISION_BASE` |

没带的头一律回退到服务端 `server/.env`。内置 Web 页面里「自带密钥」入口输入的密钥
只存在访问者浏览器的 `localStorage`。细节与 `curl` 示例见 [API.md](API.md) 第 2 节。

### 3.2 共享实例的推荐配置（强制 BYOK）

```ini
# server/.env —— 共享实例：服务端不持有可消耗的对话额度
LLM_API_KEY=                                  # ← 留空！服务端没有 key 可烧
LLM_BASE_URL=https://api.deepseek.com/v1      # 仅作为默认展示/回退
LLM_MODEL=deepseek-chat
VISION_MODEL=

# 可选：由部署者只承担「向量化」这一项（很便宜），保证材料能正常入库
EMBEDDING_API_KEY=
EMBEDDING_BASE_URL=
EMBEDDING_MODEL=text-embedding-v3

CORS_ORIGINS=https://course.example.com
```

- `LLM_API_KEY` 留空时，`GET /api/config` 返回的 **`server_key_configured` 为 `false`**
  （前端据此提示访问者「必须填自己的密钥」）。不带密钥的请求调 AI 接口时会拿到可读错误，
  而不是消耗你的额度。
- 如果连 `EMBEDDING_API_KEY` 也不配，那么**上传材料后的解析（切块 + 向量化）会失败**
  （材料 `status=failed`）——因为这一步也需要向量模型。此时要用自建客户端在上传请求里
  带上访问者自己的密钥（实测：上传请求带的 BYOK 头同样会作用于后续的后台解析任务）。
- 提醒访问者：**同一把 key 要能调 embeddings**。像 DeepSeek 只有 chat 接口，
  只填 DeepSeek key 时问答可用、但材料解析会失败——可以让访问者把 Base URL 指向
  同时提供 embeddings 的服务，或由部署者按上面那样只托管 `EMBEDDING_*`。

> 说明：`server/.env` 里配了 `EMBEDDING_API_KEY` 而 `LLM_API_KEY` 为空时，
> `server_key_configured` 仍然是 `false`——因为它只反映对话密钥。

---

## 4. 数据与备份

**`server/data/` 是唯一的持久化目录**，里面只有两样东西：

- `course_ta.db`：SQLite 数据库（课程、材料元数据、切块、题目、错题本、图谱、复习卡片、公式）；
- `materials/<course_id>/`：上传的原始课件/试卷/图片。

`data/` 已被 `.gitignore` 忽略，也**不会进镜像**。Docker 部署时它挂载到命名卷 `course-ta-data`
（容器内路径 `/app/data`，由 compose 的 `DATA_DIR` 指定）。容器重建、镜像升级都不会动这个卷。

### 备份

```bash
# 先停 API，保证 SQLite 文件不是写到一半的状态
docker compose stop api

# 把卷打包到当前目录（Windows PowerShell 把 $(pwd) 换成绝对路径，如 D:\backup）
docker run --rm -v course-ta-data:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/course-ta-data-$(date +%F).tar.gz -C /data .

docker compose start api
```

### 恢复 / 换机器

```bash
docker compose down                     # 保留卷；不要加 -v
docker volume create course-ta-data
docker run --rm -v course-ta-data:/data -v "$(pwd)":/backup alpine \
  tar xzf /backup/course-ta-data-2026-10-16.tar.gz -C /data
docker compose up -d
```

### 迁移到另一台机器

**只需搬 `server/data/` 这一个目录**（本机自用时就是直接拷目录；Docker 用上面的打包/解包）。
新机器上克隆仓库、装好依赖或起好容器、把数据放回同一相对位置即可，数据库结构与代码版本
由 `db.init_db()` 在启动时自动补齐（缺少的列会自动 `ALTER TABLE ADD COLUMN`）。

### 注意

- `docker compose down -v` 会**删掉数据卷**，等于清库；发布/排障时别顺手加 `-v`。
- 升级前先备份；重新解析材料（`server/scripts/reindex.py`）也要用到向量模型和额度。
- 注意磁盘余量：教材 PDF 与页图会持续增长。

---

## 5. 安全清单

- [ ] **`server/.env` 不进 git**（仓库 `.gitignore` 已包含 `.env`、`data/`）。不要 `git add -f`；
      误提交过就立刻吊销并更换密钥。
- [ ] **全站 HTTPS**。BYOK 密钥虽然在访问者浏览器里，但请求头会经过网络；明文 HTTP 等于泄露密钥。
- [ ] **反向代理**：公网只暴露 443（或 8080），不要直接把 8000 暴露到公网；
      只想自己用就限制来源 IP，或加 Basic Auth / Cloudflare Access。
- [ ] **访问控制**：本服务没有登录体系，任何能访问页面的人都能上传材料并占用磁盘。
      公开实例建议在反代层加认证和限流（如 `limit_req`）。
- [ ] **BYOK 密钥只在访问者浏览器 localStorage**，后端按请求使用、不落盘不写日志；
      页面与文档里都只做脱敏展示。
- [ ] 不想公开 Swagger 文档，就在外层反代里拦掉 `/docs`、`/redoc`、`/openapi.json`。
- [ ] 镜像默认以 root 运行（为了卷权限省事）。要收紧就调整 Dockerfile 里的用户，
      并保证 `/app/data` 对该用户可写。
- [ ] 定期更新基础镜像（`docker compose build --pull`）与依赖；`server/.env` 里的密钥定期轮换。
- [ ] 备份放在别处（异地/对象存储），并**实际演练一次恢复**。

---

## 6. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 上传大文件返回 `413 Request Entity Too Large` | nginx 限制。本仓库 `web/nginx.conf` 已设 512m；如果你在外面还有一层反代，那一层也要设 `client_max_body_size` |
| AI 回答「不流式」，最后一次性全部出现 | 某一层代理开了响应缓冲。给 `/api`（或整站）设 `proxy_buffering off`；Caddy 用 `flush_interval -1` |
| 长回答中途 `504 Gateway Timeout` | 读超时太短，设 `proxy_read_timeout 3600s`（本仓库 nginx 已设） |
| 浏览器控制台 `blocked by CORS policy` | 把页面的真实 Origin 写进 `CORS_ORIGINS`（协议://主机:端口，无路径无斜杠），然后重启 api |
| 问答报「未配置 LLM_API_KEY」 | 服务端没配且请求没带 `X-LLM-API-Key`；要么在页面里填自己的密钥，要么在 `server/.env` 配 |
| 问答报「未配置向量模型」 | 检索需要 embeddings；配 `EMBEDDING_*`，或让请求带上可用的 BYOK 密钥 |
| 材料一直 `pending`/`ingesting` 然后 `failed` | 看 `error` 字段与 `docker compose logs -f api`：通常是向量模型不可用或额度不足 |
| `uv sync --frozen` 报 lock 过期 | 镜像里的 uv 版本与生成 `uv.lock` 的版本不一致；用相同版本，或在本地 `uv lock` 后提交新 lock |
| 8080 端口被占用 | 改 `docker-compose.yml` 里 web 的 `ports: ["8081:80"]`，并用外层反代指向新端口 |
| 想换数据库/材料存放位置 | 不要改容器内的 `DATA_DIR`，改卷映射（`volumes:`）即可 |

---

## 7. 本文档相关文件

| 文件 | 作用 |
| --- | --- |
| `server/Dockerfile` | 后端镜像：Python 3.12 + uv，`uv sync --frozen --no-dev`，监听 `0.0.0.0:8000` |
| `web/Dockerfile` | 前端镜像：Node 24 `npm ci && npm run build` → nginx |
| `web/nginx.conf` | `/api` 反代（SSE 友好、512m 上传）、SPA 回退、`/docs` 反代 |
| `docker-compose.yml` | api + web 两个服务、命名卷 `course-ta-data`、`restart: unless-stopped` |
| `server/.dockerignore`、`web/.dockerignore` | 保证 `.env`、`data/`、`node_modules/`、`dist/` 不进构建上下文 |
| `docs/API.md` | 端点与 BYOK 请求头说明 |

### 验证状态（诚实声明）

本文档中的 Dockerfile / compose / nginx 配置是**按仓库真实代码路径编写并逐条核对**的：

- `docker-compose.yml` 已通过 YAML 解析校验；
- 镜像里的构建命令已在宿主机上用**同样的命令**验证过：
  `uv sync --frozen --no-dev`（成功，`import app.main` 正常）、`npm ci && npm run build`（成功，产出 `dist/`）；
- 端点表与运行中应用的 `/openapi.json` 逐条核对过；BYOK 请求头名与 `server/app/config.py` 一致；
- **当前开发机未安装 Docker**，因此 `docker build` / `docker compose up` 与 nginx 实际运行
  尚未实测（`nginx -t` 也无法执行）。首次部署时请以 `docker compose logs` 为准。

> **2026-10-16 更新：Docker 已安装，上述内容已实测通过。** 实测结论：
>
> - `docker compose build` 两个镜像构建成功（`course-ta-api:local`、`course-ta-web:local`）；
> - `docker compose up -d` 后 api 容器为 `healthy`、web 容器发布 8080；
> - 经 nginx 验证：`/` 返回页面、`/api/health` 与 `/api/config` 反代正常、SPA 深链接回退 200、
>   `/docs` 可用；容器首启自动建库并种入 35 条预置公式；
> - **命名卷持久化已实测**：`docker compose down`（删容器、保留卷）后 `up -d`，
>   容器内新建的课程仍在；`down -v` 才会连数据一起清空。
> - **发现并修复一个真实冲突**：原先 api 服务把 `8000` 发布到宿主机，只要本机正在跑
>   `uvicorn --port 8000`（开发时的常见状态）就会 `ports are not available` 导致整个编排起不来。
>   现已默认不发布该端口（web 容器通过 compose 内网 `api:8000` 访问），需要时再手动打开注释。
> - 国内拉取 Docker Hub 的注意事项见下节。

## 附：Docker 空实例的用途与数据管理

本机当前跑着一个 **Docker 空实例**（`http://localhost:8080`），它**故意不含课程数据**：
用途是验证"任何人克隆仓库后照着文档能不能把整套服务跑起来"，属于干净的部署回归环境。

它与本机开发实例（`http://localhost:5173`，含真实课程数据）是**两份独立数据**，
改内容时要明确改的是哪一份，不要混用。常用操作：

```bash
# 查看状态
docker compose ps

# 停掉但保留数据（下次 up 数据仍在）
docker compose down

# 彻底重置为空实例（数据一并删除）
docker compose down -v && docker compose up -d

# 把本机真实数据灌进容器（可选；拷入命名卷，容器内为 /app/data）
docker compose stop api
docker run --rm \
  -v course-ta-data:/data \
  -v "D:\projects\course-ta\server\data:/src:ro" \
  alpine sh -c "cp -r /src/. /data/"
docker compose start api

# 备份容器内数据到本机
docker run --rm \
  -v course-ta-data:/data \
  -v "D:\Backup\course-ta-docker:/out" \
  alpine sh -c "cp -r /data/. /out/"
```

> 注意：容器以 root 运行、卷内文件属 root，宿主机直接改卷目录会比较别扭；
> 常规做法是上面的 `docker run --rm` 临时容器来导入/导出。

## 附：国内环境拉取镜像

Docker Hub 在国内常被阻断。本机实测（2026-10）：

- `registry-1.docker.io` / `auth.docker.io` **直连超时**；但 Docker Desktop 自带代理转发
  （`docker info` 里可见 `HTTP Proxy: http.docker.internal:3128`）可复用宿主机代理；
- 免费加速器**大量已关停**：腾讯云、中科大、网易、百度镜像实测均为 `000` 不可达；
- 仍可用的公益镜像（实测 `/v2/` 有正常响应）：`docker.1panel.live`、`docker.1ms.run`、
  `docker.xuanyuan.me`。

配置方式（写入 `~/.docker/daemon.json` 后重启 Docker 引擎）：

```json
{
  "registry-mirrors": [
    "https://docker.1panel.live",
    "https://docker.1ms.run",
    "https://docker.xuanyuan.me"
  ]
}
```

注意：第三方公益镜像能看到你拉取了哪些镜像，**只用于公开基础镜像即可**，不要用它推送私有镜像。
公司/学校网络下更稳妥的做法是在 Docker Desktop → Settings → Resources → Proxies 里配置代理。


## 附：视觉模型换用 DeepSeek

项目支持「对话」与「图片理解」用**不同服务商**。DeepSeek 的多模态模型为
`deepseek-flash`（2026-08 上线，旧名 `deepseek-v4-flash-vision-exp` 仍可调用），
采用标准 OpenAI 图像格式，本项目已实现的 `image_url` + base64 调用方式直接兼容。

```ini
; server/.env —— 只加这三行，对话与向量保持原样
VISION_MODEL=deepseek-flash
VISION_BASE=https://api.deepseek.com/v1
VISION_KEY=sk-你的DeepSeek密钥
```

- 图片按 token 计费（单图上限约 1024 tokens），与 V4-Flash 同价；空闲时段价格减半。
- 不填 `VISION_KEY` 时复用 `LLM_API_KEY`；不填 `VISION_MODEL` 时跳过图片描述，图片仍可上传与查看。
- 改完**必须重启后端**（uvicorn 未开 `--reload`）。
- 验证：上传一张图片，看材料正文是否出现 `[图片 1] …`；或 `GET /api/config` 查
  `vision_separate_provider` 是否为 `true`。

## 附：免费域名与校内分享

- **`.edu.cn` 个人申请不到**：该后缀的申请主体必须是教育机构，需要单位资质与 CNNIC 流程，
  个人或学生社团无法直接注册。
- **清华 TUNA 不提供域名注册**：它提供的是 [DNS 查询服务](https://tuna.moe/help/dns/) 与镜像站，
  不是域名托管方。
- **免费二级域名**（如 [localhost.cc](https://github.com/localhost-cc/Freedomain)、
  [register-edu](https://github.com/xiaokun567/register-edu)）可做临时演示，但归属、稳定性与
  续期政策都不由你控制，**不建议承载课程数据**。
- **推荐路径**：校内直接用校园网地址分享；需要正式域名与固定服务器时，向学校信息化部门
  申请，或走院系立项。若必须公网可用，可用 Cloudflare Tunnel 之类内网穿透把本机服务
  映射到自有域名（无需公网 IP），但需遵守学校网络使用规定。

### 校内分享的最小配置

```bash
# 1) 后端绑定所有网卡（关键：绑 127.0.0.1 时同学访问不到）
cd server
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000

# 2) 前端也要对外监听（Vite 默认只监听 localhost）
cd ../web
npm run dev -- --host 0.0.0.0

# 3) 允许同学的浏览器来源，把地址换成你的实际 IP
#    server/.env: CORS_ORIGINS=http://<你的IP>:5173,http://localhost:5173
```

同学访问 `http://<你的IP>:5173`。注意：

- 学校防火墙可能**禁止入站**，先让同学实际访问确认；
- 关机/休眠服务即中断，长期共享建议放到院系服务器；
- 想避免被消耗额度，用 BYOK：`server/.env` 里**不填** `LLM_API_KEY`，访问者必须自带密钥。
