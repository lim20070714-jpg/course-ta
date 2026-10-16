from datetime import UTC, datetime

from sqlmodel import Field, SQLModel


def _now() -> datetime:
    return datetime.now(UTC)


class Course(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    description: str = ""
    created_at: datetime = Field(default_factory=_now)


class Material(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    course_id: int = Field(index=True, foreign_key="course.id")
    filename: str
    stored_path: str
    kind: str = "other"  # textbook 教材 | slides 课件 | handout 讲义 | exam 试题 | other 其他
    status: str = "pending"  # pending | ingesting | ready | failed
    error: str = ""
    chunk_count: int = 0
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
