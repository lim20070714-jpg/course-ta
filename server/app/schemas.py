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
