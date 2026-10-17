# CourseTA 技术亮点与工程指标

> 一页纸说明：这个平台解决什么、难在哪、怎么验证。所有数字都是本仓库当前 HEAD 的实测值，按文末命令可以复现。

## 它是什么

用一门真实的电路类课程做出来、并且自己一直在用的**分区式**学习平台，而不是又一个聊天机器人：
课程资料、题库与解答、做题足迹、复习计划、限时模考、计算台、知识图谱、电路实验台 8 个分区各管一件事，
LLM 只做支撑（抽取、批改、总结、图谱归纳），学生始终在结构化界面上学习。它不绑定某门课、某位老师或某所学校——
换一批材料就是你的另一门课。后端 FastAPI + SQLite + PyMuPDF + SymPy，前端 React + TypeScript + KaTeX，
自研 SPICE 式电路仿真引擎跑在浏览器里，不依赖任何仿真服务。

## 30 秒指标

| 指标 | 值 |
| --- | --- |
| 主界面分区 | 8 个（⌘1..8 与命令面板直达） |
| 后端 API operation | 57 个（覆盖 42 条路径），OpenAPI 自动生成 |
| 自动化测试 | **702** 个：后端 315（pytest，全部离线）+ 前端 387（Vitest，18 个文件） |
| 静态检查 | ruff + tsc + oxlint 零告警；CI 2 个 job（后端 / 前端）全绿 |
| 代码规模 | 约 34.2k 行：后端 `server/app` 6,432、`server/tests` 3,981、前端 `web/src` ts/tsx 17,644、`web/src/index.css` 6,135 |
| 自托管 | `docker-compose` 一键；前端 nginx 静态托管 + 反向代理；默认 `http://localhost:8080` |
| 密钥模式 | BYOK：用户填自己的 Key，服务端可完全不留密钥 |
| 许可 | MIT |

## 七个真正的技术难点

**1. 试卷 / 课件 PDF 的版面级还原（`server/app/core/ingest.py`、`glyph_tables.py`、`crops.py`）**
课件里的公式多是 MathType/Wingdings 嵌入的匿名子集字体，ToUnicode 映射丢失，PyMuPDF 只能回退成
`0xF000 + 字节` 的私有区字符；另有一些字体把字符错映射到天城文/卡纳达文码点。2D 排布的公式与矩阵还会被
PDF 拆成一行只有两三个字的碎片。管线因此分四步：按 span 的 y 轴重叠率做**行聚类**重建视觉行（`_rows_from_spans`），
按字体族查 **符号表解码**（Adobe Symbol / Wingdings / glitch 修正表，`_decode_span`），把被拆开的大定界符
组合件合并回定界符（`_collapse_delimiter_pieces`），再给每页算一个**质量分** = 无法还原字符数 + 定界符碎片数 +
短行碎片度（`_frag_score`）。只有质量分最差的那几页才送去做 LLM 语义修复（`_repair_targets` → `_repair_one`），
并且修复结果要做长度与 `$$` / `\[ \]` 配对校验，疑似截断就退回原文——**LLM 只兜底，不做主链路**。
题目配图按「题号标记行」估计裁剪边界（题干已被 LLM 改写成 LaTeX，无法再做子串匹配），定位失败退化为整页。

**2. 浏览器里的电路仿真引擎（`web/src/circuit/`，相关测试 111 个）**
没有调用任何外部仿真器：`solver.ts` 用**改进节点法**为电阻、受控源、理想运放逐个 stamp 导纳矩阵；
`linalg.ts` 是自己写的**带部分主元的稠密复数高斯消元**；`transient.ts` 用**后向欧拉**离散，
电容/电感以**伴随模型**（companion）并入同一矩阵；交流分析走相量 + 频响扫频。
上层是搭建器（`labs/builder.ts`：网格放置、连线磁吸 → 网表提取）与仪器面板（`labs/instruments.ts`：示波器、直流读数、频响扫频）。
每个数值方法都有独立测试（DC 12 / AC 7 / 瞬态 13 / 搭建器 20 / 仪器 34 / 预置实验 25），不是「跑起来看着对」。

**3. 知识图谱的两级抽取与可回溯锚定（`server/app/core/graph.py`，前端布局测试 102 个）**
一次性让模型「画出整门课的图谱」必然产生空洞节点和幻觉边。改成两级：先按材料把知识点清单分批归纳成候选概念
（并发 3），再把候选概念**合并**为总览 → 模块 → 概念 → 前置/相关关系；关系密度不足时追加专门的关系抽取轮次。
每个概念用名称与关键词回匹配来源材料和页码，点击即可跳原文。前端放弃了不可读的力导向图，
改为思维导图式层级布局 + 可折叠树（`graphTree` 71 个测试）。

**4. SM-2 与真实考试日期耦合（`server/app/core/review.py`，冲刺测试 33 个）**
标准 SM-2 的间隔会越拉越长，考前一个月还排到 90 天后就是有害的。这里在 `cap_interval` 里把下次复习时间
**夹紧到严格早于考试时刻**，进入 30 天窗口后按冲刺节奏压缩间隔并分阶段提示，再叠加考点热度加权，
把「复习计划」从通用记忆算法变成有截止日的排期问题。

**5. 限时模考的服务端权威计时与答案保密（`server/app/core/exams.py`、`api/exams.py`，测试 17 个）**
倒计时不放在浏览器：服务端记录 `deadline_at = started_at + duration_min`，每个响应回传 `seconds_left`，
刷新页面不会重置，到点自动交卷并标记 `late`。组卷只取「题干与参考答案都非空」的题（没有答案就无法给可信判定），
抽取核心接受 seed 以便复现同一份卷子（测试依赖这点）；参考答案在 `status != done` 之前**绝不下发**。批改是后台任务（一题一次模型调用，
整卷可能几分钟），进度与逐题判定分别放在进程内任务表和数据库里，服务重启只丢进度不丢成绩。
做错的题同步写入 Attempt，于是模考里的错题自然进入错题本和复习计划。

**6. 删除资料时的「删什么、留什么」（`server/app/api/courses.py`，测试 8 个）**
一份材料连着四层数据：原文件与页图、知识块与向量、学习总结、从它切出来的题目。
题目上还挂着作答记录、错题本、复习卡与模考成绩，所以删除按数据的所有权分层：
材料本体、知识块、总结、磁盘上的原件与页图一并清除；题目与概念只把 `material_id` 置空——
练过的题不会因为一次误删而消失，代价只是不再有「原题原页图」。
另一个坑是 SQLite 的 rowid 复用：材料删掉后新上传可能拿到同一个 id，如果此时还有在跑的后台任务
（解析 / 总结 / 拆题）把结果写回来，脏数据就会「认领」到新材料身上。
因此删除接口在任务进行中直接返回 409，而不是先删行再指望任务自己发现材料没了。

**7. 改名的两处数据一致性与「历史存在哪」（`server/app/api/courses.py`、`web/src/compute/history.ts`、`labs/drawings.ts`）**
`Material.filename` 同时是显示名和磁盘路径的一部分（`data/materials/{course_id}/{filename}`），所以改名必须让
`Path.replace()` 与 `stored_path` 一起生效；页图按 `media/{material_id}/` 存放，与文件名无关，改名后跳页仍然可用。
校验规则前端（`components/rename.ts`）与后端各写一份、口径一致，让报错立刻出现而不是等一次请求。两个真实踩过的坑：
Python 里 `set('<>:"|?*\x00-\x1f')` 会把 `\x00-\x1f` 展开成 `\x00`、`-`、`\x1f` 三个字符，于是所有带连字符的课件名
（`A1-01电路定律.pdf`）都被误判为非法——控制字符必须用 `{chr(i) for i in range(0x20)}` 生成；
PATCH 若直接返回 ORM 对象，`page_count` 会退回表里的 0（列表口径来自 `Chunk` 的最大页码），前端那一行会被重绘成「0 页」。
做题足迹、计算历史、实验台图纸三类历史一律**建表存服务端**而不是 localStorage：换浏览器不丢，也能和外键对齐。
计算台连失败记录（422 报错）一起留，点一条回填表达式与参数、直接展示当时算出的结果或错误并标注「那次运算的记录」，
不重复消耗一次 sympy 计算。图纸保存只校验顶层结构（`comps` / `wires` 是数组、元素是对象、序列化 ≤ 200k 字符），
画布语义留给前端，服务端不被编辑器版本绑死；载入时前端再做一次形状守卫，坏数据只会「读不出来」，不会崩画布。

## 工程实践

- **BYOK 用 contextvar 做按请求覆盖**（`server/app/config.py`）：请求头里的 Key / Base URL / Model 只在该请求的
  上下文内生效，不改全局配置；头部值截断到 300 字符；`describe_runtime` 与 `/api/config` 只回答「服务端有没有配密钥」，
  永不回显密钥本身。中间件 `BYOKMiddleware` 是**原生 ASGI** 而非 `BaseHTTPMiddleware`——后者会缓冲响应，
  会破坏项目里大量使用的 SSE 流式输出。
- **测试不依赖本机配置**：涉及密钥的用例用哨兵值 monkeypatch，315 个后端测试在任何没有 `.env` 的机器上
  （包括 CI）都能离线通过；前端 387 个用例同理。
- **CI 门禁**：后端 `uv sync → ruff check → pytest`，前端 `npm ci → oxlint → vitest → tsc -b && vite build`，两个 job。
- **可移植性**：服务端与前端各有 Dockerfile，`docker-compose.yml` 用命名卷持久化 SQLite 与资料目录；
  文档默认面向本机 `localhost`，域名/反代只作为对外分享的进阶路径。
- **隐私边界**：课程材料与密钥只存在于 `server/.env` 与 `server/data/`（均 gitignore），仓库内不含任何真实课件。

## 真实数据规模（本地实例，未入库）

截至 2026-10-17：3 门课、46 份材料 / 约 1.5 万个知识块 / 639 道结构化题目 / 117 个概念、315 条关系边。
平台不是为演示造的玩具，而是自己每周真在用、并被这些真实数据压过一遍的——数字还会继续长。

## 复现这些数字

```bash
cd server
uv run pytest -q          # 315 passed（无需 API key）
uv run ruff check .       # 零告警
uv run python -c "from app.main import app; print(sum(1 for p in app.openapi()['paths'].values() for m in p if m in {'get','post','put','patch','delete'}))"   # 57

cd ../web
npm run lint              # 57 个文件，0 warning 0 error
npm test                  # 387 passed
```

接口细节见 [API.md](API.md)，部署见 [DEPLOY.md](DEPLOY.md)，功能全景见 [../README.md](../README.md)。
