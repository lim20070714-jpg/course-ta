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
