from datetime import datetime

from pydantic import BaseModel


class CourseCreate(BaseModel):
    name: str
    description: str = ""


class CourseRead(BaseModel):
    id: int
    name: str
    description: str


class MaterialRead(BaseModel):
    id: int
    course_id: int
    filename: str
    status: str
    error: str
    chunk_count: int


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
    attempts: list[AttemptRead]


class TagCount(BaseModel):
    tag: str
    count: int


class WrongItem(ProblemListItem):
    last_feedback: str = ""


class GradeRequest(BaseModel):
    answer: str
