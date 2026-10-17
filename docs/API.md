# CourseTA API 说明

本文档描述后端的 HTTP 接口。**端点路径以 `server/app/api/*.py` 里的实现为准**（下表已与运行中的
`/openapi.json` 逐条核对过）。

---

## 1. 基础信息

| 项目 | 值 |
| --- | --- |
| 本机直连地址 | `http://127.0.0.1:8000`（`uv run uvicorn app.main:app --host 127.0.0.1 --port 8000`） |
| Docker Compose 部署地址 | `http://<主机>:8080`（web 容器里的 nginx 把 `/api`、`/docs` 反代到 api 容器，同源） |
| Swagger UI | `/docs` |
| ReDoc | `/redoc` |
| OpenAPI JSON | `/openapi.json` |
| 业务接口前缀 | 统一 `/api`；`/`、`/docs`、`/redoc`、`/openapi.json` 不带前缀 |
| 请求/响应格式 | JSON（上传材料为 `multipart/form-data`），字符串均为 UTF-8 |
| 鉴权 | 无（单实例自托管默认无登录）。请用反向代理 / 内网 / 云安全组限制访问 |
| 错误格式 | `{"detail": "<中文说明>"}`，HTTP 状态码如 400 / 404 / 409 / 422 / 502 |

由于前端（nginx）与 API 同源部署，**同源部署不需要配置 CORS**；只有「前端在别的域名/端口」时才必须设置
`CORS_ORIGINS`，见 [DEPLOY.md](DEPLOY.md)。

### 运行时配置查询

```bash
curl http://127.0.0.1:8000/api/config
```

实测响应（服务端未配置密钥的纯 BYOK 部署）：

```json
{
  "server_key_configured": false,
  "server_model": "deepseek-chat",
  "server_base_url": "https://api.deepseek.com/v1",
  "server_vision_model": "",
  "byok_headers": {
    "key": "x-llm-api-key",
    "base_url": "x-llm-base-url",
    "model": "x-llm-model",
    "embedding_model": "x-embedding-model",
    "vision_model": "x-vision-model"
  }
}
```

| 字段 | 含义 |
| --- | --- |
| `server_key_configured` | 服务端 `server/.env` 是否配了 `LLM_API_KEY`。**共享实例建议为 `false`**（强制访问者自带密钥） |
| `server_model` / `server_base_url` / `server_vision_model` | 服务端当前的模型与地址（可展示给访问者参考） |
| `byok_headers.*` | 自带密钥（BYOK）使用的请求头名 |

---

## 2. 自带密钥（BYOK）

共享实例上，访问者可以带自己的密钥来调用 AI 功能，这样**不消耗部署者的额度**。
覆盖值按请求生效（后端用 `contextvar` 隔离，SSE 流式响应全程一致），请求结束即失效，
服务端不持久化、也不写日志。

| 请求头 | 含义 | 覆盖的 `.env` 配置 | 示例 |
| --- | --- | --- | --- |
| `X-LLM-API-Key` | 对话 / 批改 / 提示 / 题目抽取所用的密钥 | `LLM_API_KEY` | `sk-xxxxxxxx` |
| `X-LLM-Base-URL` | OpenAI 兼容接口地址（**不要带尾部斜杠**） | `LLM_BASE_URL` | `https://api.deepseek.com/v1` |
| `X-LLM-Model` | 对话模型名 | `LLM_MODEL` | `deepseek-chat` |
| `X-Embedding-API-Key` | 向量模型密钥；对话服务商不提供 embeddings 时单独给（如 DeepSeek 对话 + DashScope 向量） | `EMBEDDING_API_KEY` | `sk-yyyyyyyy` |
| `X-Embedding-Base-URL` | 向量接口地址 | `EMBEDDING_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `X-Embedding-Model` | 向量模型名（检索用） | `EMBEDDING_MODEL` | `BAAI/bge-m3` |
| `X-Vision-Model` | 图片描述模型（留空则跳过图片描述） | `VISION_MODEL` | `Qwen/Qwen2.5-VL-32B-Instruct` |

规则细节：

- 某个头**没带、值为空、或长度超过 300** → 该项回退到 `server/.env`。
- 带了 `X-LLM-API-Key` 的请求，服务端的 `EXTRACT_MODEL` **不会**被套用（避免「你的 key + 服务端的抽取模型」混用）。
- 向量密钥优先级：`X-Embedding-API-Key` → `server/.env` 的 `EMBEDDING_API_KEY` → 本次请求的对话密钥。
  只带对话密钥时二者共用；但若该服务商没有 embeddings 接口（例如 DeepSeek），材料解析会失败，
  这时需要额外带 `X-Embedding-API-Key`。
- 指向本地模型（`llm_base_url` 含 `localhost` / `127.0.0.1`）时不带 key 也能调用；
  其他地址若既没有自带 key 也没有服务端 key，AI 接口会返回可读错误。
- 内置 Web UI 会发送 `X-LLM-API-Key` / `X-LLM-Base-URL` / `X-LLM-Model` / `X-Embedding-API-Key`
  四个头（后两个可选），密钥存在浏览器 `localStorage`（键名 `courseta.llm`），不上传、不落服务端；
  其余头供自建客户端使用。

### 示例一：不带密钥，走服务端 `.env` 配置

```bash
curl -N -X POST http://127.0.0.1:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"course_id":1,"question":"什么是 MOSFET？"}'
```

服务端没配 `LLM_API_KEY` 时，会直接在流里收到错误事件（不会 500）：

```
event: error
data: {"message": "未配置向量模型：请在 server/.env 中填写 EMBEDDING_API_KEY / EMBEDDING_BASE_URL / EMBEDDING_MODEL"}

event: done
data: {}
```

### 示例二：带自己的密钥（BYOK，不消耗部署者额度）

```bash
curl -N -X POST https://course.example.com/api/chat \
  -H "Content-Type: application/json" \
  -H "X-LLM-API-Key: sk-你的密钥" \
  -H "X-LLM-Base-URL: https://api.deepseek.com/v1" \
  -H "X-LLM-Model: deepseek-chat" \
  -H "X-Embedding-Model: text-embedding-v3" \
  -d '{"course_id":1,"question":"什么是 MOSFET？"}'
```

指向本地 Ollama（无需密钥）：

```bash
curl -N -X POST http://127.0.0.1:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-LLM-Base-URL: http://127.0.0.1:11434/v1" \
  -H "X-LLM-Model: qwen2.5:7b" \
  -d '{"course_id":1,"question":"什么是 MOSFET？"}'
```

> **Windows 提示**：在 PowerShell 里用 `-d '{...中文...}'` 容易把中文变成乱码导致 422。
> 把 JSON 存成 UTF-8 文件后改用 `--data-binary "@body.json"`（实测有效）。

---

## 3. 端点一览

### 3.1 系统

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查，返回 `{"status":"ok"}`（Docker healthcheck 用它） |
| GET | `/api/config` | 服务端是否已配密钥 + BYOK 头名 |
| GET | `/` | 返回 `{"name":"CourseTA API","docs":"/docs"}` |

### 3.2 课程与材料

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/courses` | 建课，body `{"name","description"}`；名称不能为空 |
| GET | `/api/courses` | 课程列表（含 `exam_date`，`YYYY-MM-DD` 或 `null`） |
| GET | `/api/courses/{course_id}/materials` | 课程下的材料列表（含 `status`、`page_count`、`image_pages`） |
| POST | `/api/courses/{course_id}/materials` | 上传材料，`multipart/form-data`：`file` + `kind`（默认 `auto`）。**立即返回**，解析在后台任务里跑 |
| PATCH | `/api/materials/{material_id}` | 修改材料类型，body `{"kind"}` |
| DELETE | `/api/materials/{material_id}` | 删除材料：知识块、笔记与原文件/原页图一并清除，返回 `{"status":"deleted","filename","chunks_removed","problems_kept"}` |

- `DELETE` 的保留语义：由这份材料切出的**题目会留下**（`material_id` 置空），因为作答记录、错题本、复习卡与模考成绩都挂在题目上；
  代价是这些题不再有「原题原页图」。知识图谱的概念出处同理置空，脉络本身不动。
- 材料正在后台处理（入库 / 生成笔记 / 拆题）时删除会返回 `409`，等它跑完再删——否则后台会把结果写回一个已经不存在的材料。

- 支持的后缀：`.pdf`、`.pptx`、`.docx`、`.txt`、`.md`、图片（`.png .jpg .jpeg .webp .gif .bmp .tif .tiff`）。
- `kind` 取值：`auto`（按文件名猜）、`textbook`（教材）、`slides`（课件）、`handout`（讲义）、
  `exam`（试题）、`image`（图片）、`other`（其他）。
- 材料 `status`：`pending` → `ready`（解析中/已可用）；失败时 `failed`，原因在 `error`。
- `kind=exam` 的材料入库后会**自动触发题目抽取**。
- 大文件走 nginx 时注意 `client_max_body_size`（本仓库的 `web/nginx.conf` 已设 512m）。

```bash
curl -X POST http://127.0.0.1:8000/api/courses/1/materials \
  -F "file=@第一讲_半导体基础.pdf" -F "kind=auto"
```

### 3.3 材料内容、检索与总结

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/materials/{material_id}/pages?offset=0&limit=20` | 按页取原文（`limit` 1–100），用于阅读/跳转原文 |
| GET | `/api/materials/{material_id}/page-image?page=1&zoom=2` | 原页图：图片材料直接返回文件，PDF 按页渲染 PNG（`zoom` 0.5–4） |
| GET | `/api/materials/{material_id}/summary` | 学习笔记：`status`(pending/generating/ready/failed) + `overview` + `key_points[]` |
| POST | `/api/materials/{material_id}/summary` | 重新生成总结（202），已在生成中则返回 `{"status":"generating"}` |
| GET | `/api/courses/{course_id}/search?q=关键词&limit=30` | 全文检索，返回 `hits[]`（`material_id`/`material`/`page`/`snippet`） |

### 3.4 问答（SSE）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/chat` | 基于课程材料的流式问答。body `{"course_id","question","history":[{"role","content"}]}` |

**SSE 事件**：`citations`（一次，命中材料列表）→ `delta`（多次，正文增量）→ 出错时为 `error` → 结束时 `done`。

### 3.5 题库

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/courses/{course_id}/problem-sources` | 题源列表：每份材料的题目数与抽取任务状态（`job_status`: idle/running/done/failed） |
| POST | `/api/materials/{material_id}/extract-problems` | 手动触发题目抽取（材料必须 `ready`；已在跑则 409） |
| GET | `/api/courses/{course_id}/problems` | 题目列表。查询参数：`material_id`、`knowledge`（按知识点过滤）、`status`（`unseen`/`wrong`/`correct`）、`q`、`offset`、`limit`（1–200，默认 50） |
| GET | `/api/problems/{problem_id}` | 题目详情：题干、参考答案、知识点、历史作答 `attempts[]` |
| GET | `/api/problems/{problem_id}/image?zoom=2` | 题目配图：从试卷页裁出该题区域（仅 PDF 来源） |
| POST | `/api/problems/{problem_id}/hint` | 一句话方向提示（非流式，可能耗时较长） |
| POST | `/api/problems/{problem_id}/grade` | 批改作答（SSE）。body `{"answer":"..."}`；结果会写入错题本 |
| POST | `/api/problems/{problem_id}/solution` | AI 详解（SSE） |
| GET | `/api/courses/{course_id}/wrongbook` | 错题本：最近判定为 `wrong` / `partial` 的题目 |
| GET | `/api/courses/{course_id}/problem-tags` | 知识点及其题目数（按题数降序） |

**SSE 事件**：

- `/grade`：`verdict`（最多一次，`{"verdict":"correct|partial|wrong|unknown"}`）→ `delta`（正文增量）→ `error` → `done`。
  注意 `verdict` 由模型输出里的 `【判定】` 标记解析而来，可能出现在 `delta` 之后（未解析到时以 `unknown` 结尾）。
- `/solution`：`citations` → `delta` → `error` → `done`。

### 3.6 知识图谱

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/courses/{course_id}/graph` | 图谱：`status`(pending/generating/ready/failed)、`overview`、`nodes[]`（含关联题目）、`edges[]`（prerequisite/related） |
| POST | `/api/courses/{course_id}/graph` | 重新生成图谱（202；已在生成中返回 `{"status":"generating"}`） |

### 3.7 计算台与公式库

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/compute/evaluate` | 符号计算。body `{"expr","op","var","point","lower","upper","order","symbols":[{"name","kind"}]}`，返回 `{"latex","plain","approx"}` |
| GET | `/api/formulas` | 公式列表（含预置公式，`preset` 标记） |
| POST | `/api/formulas` | 新建公式 `{"title","latex","category","note"}` |
| PUT | `/api/formulas/{formula_id}` | 修改公式（字段均可选） |
| DELETE | `/api/formulas/{formula_id}` | 删除公式 |

`op` 取值（与 `server/app/core/compute.py` 的 `OPS` 一致）：
`simplify`、`expand`、`factor`、`apart`、`trigsimp`、`diff`、`partial`、`integrate`、`limit`、
`series`、`taylor`、`solve`、`fourier`、`inverse_fourier`、`laplace`、`inverse_laplace`、
`det`、`inv`、`transpose`、`rank`、`rref`、`eigen`、`conjugate`、`expand_complex`、`abs`、`arg`、`re`、`im`、`residue`。

`symbols[].kind`：`real` / `positive` / `negative` / `integer` / `complex`（默认）。

```bash
curl -X POST http://127.0.0.1:8000/api/compute/evaluate \
  -H "Content-Type: application/json" \
  -d '{"expr":"integrate(x^2, x)","op":"integrate","var":"x"}'
```

### 3.8 复习计划与考试冲刺

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/courses/{course_id}/review/sprint` | 冲刺概览：倒计时 `days_left`、`sprint`、`status`(none/over/sprint/normal)、`stage`、`schedule`、`top_tags[]` |
| GET | `/api/courses/{course_id}/review/due?limit=100&exam=false` | 到期队列；`exam=true` 且已设考试日期时按考点热度加权（含未到期卡片） |
| GET | `/api/courses/{course_id}/review/cards` | 复习计划里的全部卡片 |
| GET | `/api/courses/{course_id}/review/stats` | 统计：卡片数、今日到期/已复习、未来 7 天预测、考试日相关计数 |
| PUT | `/api/courses/{course_id}/exam-date` | 设置/清除考试日期，body `{"exam_date":"2026-12-20"}`（空串或 `null` 表示清除） |
| GET | `/api/problems/{problem_id}/review` | 该题的复习卡片，未加入时返回 `null` |
| PUT | `/api/problems/{problem_id}/review` | 把题目加入复习计划（幂等） |
| DELETE | `/api/problems/{problem_id}/review` | 移出复习计划 |
| POST | `/api/problems/{problem_id}/review/grade` | 自评并推进 SM-2，body `{"quality":0..5}`（<3 视为遗忘） |

冲刺期定义：设置了考试日期且 `0 <= days_left <= 30`。

---

## 4. SSE（Server-Sent Events）接入

触发流式响应的端点：`POST /api/chat`、`POST /api/problems/{id}/grade`、`POST /api/problems/{id}/solution`。

响应头（本地实测）：

```
HTTP/1.1 200 OK
content-type: text/event-stream; charset=utf-8
cache-control: no-store
x-accel-buffering: no
transfer-encoding: chunked
```

### 帧格式

每行为 `字段: 值`，行分隔符是 **CRLF（`\r\n`）**，**空行**表示一个事件结束（原始字节实测）：

```
event: error\r\n
data: {"message": "..."}\r\n
\r\n
event: done\r\n
data: {}\r\n
\r\n
```

同一个 `data` 的值永远是**单行 JSON**（后端用 `json.dumps(..., ensure_ascii=False)` 序列化，中文不转义）。

### 事件名与载荷

| 端点 | 事件 | data |
| --- | --- | --- |
| `/api/chat` | `citations` | `[{"material_id","material","page","snippet"}]` |
| | `delta` | `{"text":"增量文本"}` |
| | `error` | `{"message":"可读错误"}` |
| | `done` | `{}` |
| `/api/problems/{id}/grade` | `verdict` | `{"verdict":"correct"\|"partial"\|"wrong"\|"unknown"}` |
| | `delta` | `{"text":"增量文本"}` |
| | `error` / `done` | 同上 |
| `/api/problems/{id}/solution` | `citations` / `delta` / `error` / `done` | 同上 |

### 心跳与代理

- `sse-starlette`（本项目用 3.5.0）默认每 **15 秒**发一行注释心跳：`: ping - <UTC 时间戳>`。
  注释行以 `:` 开头，客户端**必须忽略**（按空行切块后 `raw.startsWith(':')` 直接跳过）。
- 反向代理必须关闭响应缓冲（本仓库 `web/nginx.conf` 已设 `proxy_buffering off` 并把
  `proxy_read_timeout` 放宽到 3600s）。**任何一层代理开着缓冲，都会让 `delta` 攒到最后一次性出现**，
  表现为「AI 不流式输出」。
- 因为要 POST + 自定义请求头（BYOK），浏览器端不能用原生 `EventSource`，用 `fetch` + `ReadableStream`。

### 浏览器端接入片段（含 BYOK）

```ts
type SseHandler = (event: string, payload: any) => void

/** 逐事件解析 SSE 流；自动跳过 ": ping" 心跳，兼容 \r\n 与 \n */
export async function streamSse(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  onEvent: SseHandler,
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) throw new Error(`${res.status} ${await res.text()}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    let m: RegExpMatchArray | null
    while ((m = buf.match(/\r?\n\r?\n/)) && m.index !== undefined) {
      const raw = buf.slice(0, m.index)
      buf = buf.slice(m.index + m[0].length)
      if (!raw || raw.startsWith(':')) continue // 心跳注释

      let event = 'message'
      const data: string[] = []
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      onEvent(event, data.length ? JSON.parse(data.join('\n')) : {})
    }
  }
}

// 用法 1：不带密钥（用服务端配置 / 或服务端本来就没配）
await streamSse('/api/chat', { course_id: 1, question: '什么是 MOSFET？' }, {}, (event, payload) => {
  if (event === 'citations') renderCitations(payload)
  else if (event === 'delta') appendText(payload.text)
  else if (event === 'error') showError(payload.message)
  else if (event === 'done') finish()
})

// 用法 2：BYOK——带上访问者自己的密钥（不消耗部署者额度）
await streamSse(
  '/api/chat',
  { course_id: 1, question: '什么是 MOSFET？' },
  {
    'X-LLM-API-Key': myKey,
    'X-LLM-Base-URL': 'https://api.deepseek.com/v1',
    'X-LLM-Model': 'deepseek-chat',
  },
  (event, payload) => {
    /* 同上；批改接口还会收到 verdict 事件 */
  },
)
```

> 仓库内置前端的实现见 `web/src/api.ts`（请求封装）与 `web/src/llmKey.ts`（密钥的 localStorage 读写、
> 脱敏展示、请求头构造），可直接对照或复用。

---

## 5. 端到端小例子

```bash
BASE=http://127.0.0.1:8000

# 1) 建课
curl -s -X POST $BASE/api/courses -H "Content-Type: application/json" \
  -d '{"name":"电子电路与系统基础"}'

# 2) 上传课件（返回 id，解析在后台跑）
curl -s -X POST $BASE/api/courses/1/materials -F "file=@lecture01.pdf" -F "kind=auto"

# 3) 等 status 变成 ready
curl -s $BASE/api/courses/1/materials

# 4) 全文检索
curl -s "$BASE/api/courses/1/search?q=共源极&limit=5"

# 5) 流式问答（带自己的密钥）
curl -N -X POST $BASE/api/chat -H "Content-Type: application/json" \
  -H "X-LLM-API-Key: sk-你的密钥" \
  --data-binary "@body.json"        # {"course_id":1,"question":"什么是共源极放大器？"}
```
