from datetime import UTC, datetime

from sqlmodel import Field, SQLModel


def _now() -> datetime:
    return datetime.now(UTC)


class Course(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    description: str = ""
    exam_date: datetime | None = Field(default=None)  # 考试日期（UTC 零点，仅日期语义）
    created_at: datetime = Field(default_factory=_now)


class Material(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    course_id: int = Field(index=True, foreign_key="course.id")
    filename: str
    stored_path: str
    kind: str = "other"  # textbook | slides | handout | exam | image | other
    status: str = "pending"  # pending | ingesting | ready | failed
    error: str = ""
    chunk_count: int = 0
    # 图片页：JSON 数组 [{"page": 3, "path": "media/12/docx/image-003.png"}]，
    # path 相对 data_dir；非图片材料为空数组
    pages: str = "[]"
    created_at: datetime = Field(default_factory=_now)


class Chunk(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    course_id: int = Field(index=True)
    material_id: int = Field(index=True)
    page: int = 0
    seq: int = 0
    text: str
    embedding: bytes | None = Field(default=None)


class Problem(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    course_id: int = Field(index=True, foreign_key="course.id")
    material_id: int | None = Field(default=None, index=True, foreign_key="material.id")
    page: int = 0
    number: str = ""  # 题号，如「一、1」「3」
    stem: str = ""  # 题干（Markdown + LaTeX）
    answer: str = ""  # 参考答案/解析（材料自带，可能为空）
    knowledge: str = "[]"  # 知识点标签，JSON 数组字符串
    created_at: datetime = Field(default_factory=_now)


class Attempt(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    problem_id: int = Field(index=True, foreign_key="problem.id")
    answer_text: str = ""
    verdict: str = "unknown"  # correct | partial | wrong | unknown
    feedback: str = ""
    created_at: datetime = Field(default_factory=_now)


class Summary(SQLModel, table=True):
    material_id: int = Field(primary_key=True, foreign_key="material.id")
    overview: str = ""  # 整体总结（Markdown + LaTeX）
    key_points: str = "[]"  # 知识点 JSON: [{title, detail, pages: [int]}]
    status: str = "pending"  # pending | generating | ready | failed
    error: str = ""
    created_at: datetime = Field(default_factory=_now)


class Formula(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    title: str
    latex: str
    category: str = "自定义"  # 微积分 | 代数 | 变换 | 线性代数 | 复数 | 物理与工程 | 自定义
    note: str = ""
    preset: bool = False
    created_at: datetime = Field(default_factory=_now)


class CourseGraph(SQLModel, table=True):
    course_id: int = Field(primary_key=True, foreign_key="course.id")
    overview: str = ""  # 课程脉络总览（Markdown + LaTeX）
    status: str = "pending"  # pending | generating | ready | failed
    error: str = ""
    updated_at: datetime = Field(default_factory=_now)


class Concept(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    course_id: int = Field(index=True, foreign_key="course.id")
    name: str
    description: str = ""  # 概念解释（Markdown + LaTeX）
    module: str = ""  # 所属模块（脉络分组）
    order: int = 0  # 全局顺序（模块内按此排序）
    material_id: int | None = Field(default=None, foreign_key="material.id")
    page: int = 0
    created_at: datetime = Field(default_factory=_now)


class ConceptEdge(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    course_id: int = Field(index=True, foreign_key="course.id")
    source_id: int = Field(index=True, foreign_key="concept.id")
    target_id: int = Field(index=True, foreign_key="concept.id")
    relation: str = "related"  # prerequisite | related
    note: str = ""


class ReviewCard(SQLModel, table=True):
    """SM-2 间隔重复卡片：一题一卡，记录调度状态。"""

    id: int | None = Field(default=None, primary_key=True)
    problem_id: int = Field(index=True, unique=True, foreign_key="problem.id")
    course_id: int = Field(index=True, foreign_key="course.id")
    ease: float = 2.5  # 难度系数 EF，下限 1.3
    interval_days: float = 0.0  # 当前复习间隔（天）
    reps: int = 0  # 连续记住次数
    lapses: int = 0  # 累计遗忘次数
    due_at: datetime = Field(default_factory=_now, index=True)
    last_review_at: datetime | None = Field(default=None)
    created_at: datetime = Field(default_factory=_now)


class MockExam(SQLModel, table=True):
    """限时模考：一次组卷 + 倒计时 + 交卷批改的完整记录。

    计时以服务端为准（deadline_at 由开考时刻与时长算出），前端倒计时只做显示。
    """

    id: int | None = Field(default=None, primary_key=True)
    course_id: int = Field(index=True, foreign_key="course.id")
    title: str = "模拟卷"
    duration_min: int = 60  # 限时（分钟）
    problem_ids: str = "[]"  # 组卷顺序，JSON 数组
    status: str = "ready"  # ready | running | grading | done | failed
    error: str = ""
    started_at: datetime | None = Field(default=None)
    deadline_at: datetime | None = Field(default=None)
    submitted_at: datetime | None = Field(default=None)
    late: bool = False  # 交卷时是否已超过截止时间
    score: float = 0.0  # 百分制
    created_at: datetime = Field(default_factory=_now)


class ExamAnswer(SQLModel, table=True):
    """模考逐题作答与批改结果（交卷前只有 answer_text，交卷后补判定与反馈）。"""

    id: int | None = Field(default=None, primary_key=True)
    exam_id: int = Field(index=True, foreign_key="mockexam.id")
    problem_id: int = Field(index=True, foreign_key="problem.id")
    answer_text: str = ""
    verdict: str = "unanswered"  # correct | partial | wrong | unknown | unanswered
    feedback: str = ""
    updated_at: datetime = Field(default_factory=_now)


class ComputeRun(SQLModel, table=True):
    """计算台的一行历史：成功记结果，失败记错误信息（报错本身也是复习线索）。

    只保留最近若干条，写入后裁剪旧行；表很小，不建索引。
    """

    id: int | None = Field(default=None, primary_key=True)
    expr: str
    op: str = "simplify"
    args: str = "{}"  # 其余入参（var / point / lower / upper / order / symbols）JSON，供历史回填
    result_latex: str = ""
    result_plain: str = ""
    approx: str = ""
    error: str = ""
    created_at: datetime = Field(default_factory=_now)


class LabDrawing(SQLModel, table=True):
    """实验台图纸：画布上的元件与连线按 JSON 存下来，换浏览器也能继续画。

    `build` 是 {"comps": [...], "wires": [...]} 的 JSON 字符串，结构由前端负责；
    服务端只做大小与顶层形状校验，改名/存版本都只动这一行。
    """

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    lab_id: str = "__free"  # 归属的实验（__free 表示自由画布）
    build: str = '{"comps": [], "wires": []}'
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)
