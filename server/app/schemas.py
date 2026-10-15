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


class ChatTurn(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    course_id: int
    question: str
    history: list[ChatTurn] = []
