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
