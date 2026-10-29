"""接口出入参模型。

`exam_date` 语义上只是「哪一天考试」，因此对外一律序列化为 `YYYY-MM-DD`，
不暴露内部用来存储的 UTC 零点 datetime（避免前端/客户端误解时区）。
"""

from datetime import date, datetime
from typing import Any

from pydantic import BaseModel


class CourseCreate(BaseModel):
    name: str
    description: str = ""


class CourseUpdate(BaseModel):
    name: str | None = None  # None 表示这次不改课程名
    description: str | None = None  # 空串表示清掉简介


class CourseRead(BaseModel):
    id: int
    name: str
    description: str
    exam_date: date | None = None  # 只暴露日期，不含时间与时区


class ExamDateUpdate(BaseModel):
    exam_date: str | None = None  # "YYYY-MM-DD"；None 表示清除考试日期


class ExamDateRead(BaseModel):
    course_id: int
    exam_date: date | None = None


class MaterialRead(BaseModel):
    id: int
    course_id: int
    filename: str
    kind: str = "other"  # textbook | slides | handout | exam | image | other
    status: str
    error: str
    chunk_count: int
    page_count: int = 0  # 含图片页的总页数
    image_pages: list[int] = []  # 可以直接看原页图的页码


class MaterialUpdate(BaseModel):
    kind: str | None = None  # 类型标签由人工选定，改名不会重新判定它
    filename: str | None = None  # 显示名，同时也是磁盘上原件的文件名


class MaterialDeleteResult(BaseModel):
    status: str = "deleted"
    filename: str
    chunks_removed: int
    problems_kept: int  # 由这份资料抽出、但被保留下来的题目数


class PageOut(BaseModel):
    page: int
    text: str


class MaterialPagesRead(BaseModel):
    material_id: int
    filename: str
    page_count: int
    offset: int
    limit: int
    pages: list[PageOut]


class SearchHit(BaseModel):
    material_id: int
    material: str
    page: int
    snippet: str


class SearchRead(BaseModel):
    query: str
    hits: list[SearchHit]


class ChatTurn(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    course_id: int
    question: str
    history: list[ChatTurn] = []


class ProblemSourceRead(BaseModel):
    material_id: int
    filename: str
    kind: str = "other"
    status: str
    problem_count: int
    job_status: str = "idle"  # idle | running | done | failed
    job_error: str = ""


class ProblemListItem(BaseModel):
    id: int
    material_id: int | None
    material: str
    page: int
    number: str
    excerpt: str
    knowledge: list[str]
    attempt_count: int
    last_verdict: str = ""


class ProblemListRead(BaseModel):
    total: int
    items: list[ProblemListItem]


class AttemptRead(BaseModel):
    id: int
    answer_text: str
    verdict: str
    feedback: str
    created_at: datetime


class ProblemDetailRead(BaseModel):
    id: int
    course_id: int
    material_id: int | None
    material: str
    page: int
    number: str
    stem: str
    answer: str
    knowledge: list[str]
    solution: str = ""
    solution_citations: list[SearchHit] = []
    solution_model: str = ""
    attempts: list[AttemptRead]


class AttemptHistoryItem(BaseModel):
    """一条作答足迹：判定 + 时间 + 题目定位，够前端按天分组并跳回原题。"""

    attempt_id: int
    problem_id: int
    material: str
    page: int
    number: str
    excerpt: str
    knowledge: list[str]
    verdict: str
    answer_text: str
    feedback: str
    created_at: datetime


class AttemptHistoryCounts(BaseModel):
    total: int
    correct: int
    partial: int
    wrong: int
    unknown: int
    problems_touched: int  # 至少做过一次的题数
    problems_ever_wrong: int  # 曾经做错/半对的题数（含后来做对的）


class AttemptHistoryRead(BaseModel):
    counts: AttemptHistoryCounts
    filtered: int  # 当前筛选条件下的记录数（counts 始终统计全量）
    items: list[AttemptHistoryItem]


class TagCount(BaseModel):
    tag: str
    count: int


class WrongItem(ProblemListItem):
    last_feedback: str = ""


class GradeRequest(BaseModel):
    answer: str


class KeyPointRead(BaseModel):
    title: str
    detail: str
    pages: list[int] = []


class SummaryRead(BaseModel):
    material_id: int
    status: str  # pending | generating | ready | failed
    overview: str = ""
    key_points: list[KeyPointRead] = []
    error: str = ""


class ComputeSymbolIn(BaseModel):
    name: str
    kind: str = "complex"  # real | positive | negative | integer | complex


class ComputeRequest(BaseModel):
    expr: str
    op: str = "simplify"
    var: str = "x"
    point: str = ""
    lower: str = ""
    upper: str = ""
    order: int = 1
    symbols: list[ComputeSymbolIn] = []


class ComputeResult(BaseModel):
    latex: str
    plain: str
    approx: str = ""


class ComputeRunRead(BaseModel):
    id: int
    expr: str
    op: str
    args: dict[str, Any]  # 回填用的其余入参
    result_latex: str
    result_plain: str
    approx: str
    error: str  # 非空表示这次运算失败，结果是错误信息
    created_at: datetime


class ComputeHistoryRead(BaseModel):
    total: int
    kept: int  # 服务端最多留这么多条
    items: list[ComputeRunRead]


class ComputeHistoryCleared(BaseModel):
    status: str = "cleared"
    removed: int


class LabDrawingIn(BaseModel):
    name: str
    lab_id: str = "__free"
    build: dict[str, Any]  # {"comps": [...], "wires": [...]}，画布结构由前端负责


class LabDrawingRead(BaseModel):
    id: int
    name: str
    lab_id: str
    comp_count: int
    wire_count: int
    updated_at: datetime


class LabDrawingDetail(LabDrawingRead):
    build: dict[str, Any]


class LabDrawingDeleted(BaseModel):
    status: str = "deleted"
    name: str


class FormulaCreate(BaseModel):
    title: str
    latex: str
    category: str = "自定义"
    note: str = ""


class FormulaUpdate(BaseModel):
    title: str | None = None
    latex: str | None = None
    category: str | None = None
    note: str | None = None


class FormulaRead(BaseModel):
    id: int
    title: str
    latex: str
    category: str
    note: str
    preset: bool


class GraphProblemRef(BaseModel):
    id: int
    number: str
    material: str = ""


class GraphNodeRead(BaseModel):
    id: int
    name: str
    description: str
    module: str
    order: int
    material_id: int | None = None
    material: str = ""
    page: int = 0
    problems: list[GraphProblemRef] = []


class GraphEdgeRead(BaseModel):
    source: int
    target: int
    relation: str  # prerequisite | related
    note: str = ""


class GraphRead(BaseModel):
    course_id: int
    status: str  # pending | generating | ready | failed
    error: str = ""
    overview: str = ""
    nodes: list[GraphNodeRead] = []
    edges: list[GraphEdgeRead] = []


class ReviewCardRead(BaseModel):
    problem_id: int
    course_id: int
    ease: float
    interval_days: float
    reps: int
    lapses: int
    due_at: datetime
    last_review_at: datetime | None = None


class ReviewDueItem(ReviewCardRead):
    number: str = ""
    material: str = ""
    page: int = 0
    excerpt: str = ""
    knowledge: list[str] = []
    weight: float = 0.0  # 冲刺队列排序权重
    reasons: list[str] = []  # 为什么排在前面（高频考点 / 已到期 / 多次遗忘）


class SprintRecommendation(BaseModel):
    knowledge: str
    count: int
    score: float


class ReviewSprintRead(BaseModel):
    course_id: int
    exam_date: date | None = None
    days_left: int | None = None  # 0 = 考试当天，负数 = 考试已过
    sprint: bool = False  # 是否处于冲刺期（考试日期已设置且 0 <= days_left <= 30）
    status: str = "none"  # none | over | sprint | normal
    schedule: list[int] = []  # 冲刺复习节奏（天）
    stage: str = ""  # 基础巩固 | 强化冲刺 | 考前收尾 | 临考突击
    due_count: int = 0  # 当前已到期卡片数
    sprint_pool: int = 0  # 复习计划卡片总数
    recommended: int = 0  # 冲刺队列本次可推进的卡片数
    tag_total: int = 0  # 题库中出现的知识点标签数
    message: str = ""
    top_tags: list[SprintRecommendation] = []


class ReviewGradeRequest(BaseModel):
    quality: int  # 0-5，<3 视为遗忘


class ReviewDayCount(BaseModel):
    date: str  # ISO 日期
    count: int


class ReviewStatsRead(BaseModel):
    card_count: int
    due_now: int
    reviewed_today: int
    forecast: list[ReviewDayCount] = []
    exam_date: date | None = None
    exam_days_left: int | None = None  # 距考试天数，可为负（已过）
    due_before_exam: int = 0  # 考试日结束前到期的卡片数（含逾期）


class MockExamCreate(BaseModel):
    title: str = ""
    count: int = 10  # 组卷题数
    duration_min: int = 60  # 限时（分钟）
    knowledge: str = ""  # 只抽该知识点的题，留空不限
    material_id: int | None = None  # 只抽某份材料的题，留空不限


class MockExamRead(BaseModel):
    id: int
    course_id: int
    title: str
    status: str  # ready | running | grading | done | failed
    count: int
    duration_min: int
    score: float
    late: bool
    started_at: datetime | None
    deadline_at: datetime | None
    submitted_at: datetime | None
    seconds_left: int  # 剩余时间（服务端算，<=0 表示已超时）
    answered: int  # 已作答的题数
    graded: int = 0  # 批改进度（grading 期间轮询用）
    error: str = ""


class MockExamItem(BaseModel):
    """模考中的单题。考试未结束时不下发参考答案，避免边做边抄。"""

    problem_id: int
    number: str
    material: str
    page: int
    knowledge: list[str]
    stem: str
    answer_text: str = ""
    verdict: str = "unanswered"
    feedback: str = ""
    answer: str = ""  # 参考答案，仅 done 状态给出


class MockExamDetail(BaseModel):
    exam: MockExamRead
    items: list[MockExamItem]


class MockExamListItem(BaseModel):
    id: int
    title: str
    status: str
    count: int
    duration_min: int
    score: float
    late: bool
    created_at: datetime
    submitted_at: datetime | None


class ExamAnswerUpdate(BaseModel):
    answer_text: str
