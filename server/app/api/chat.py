import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException
from sqlmodel import Session
from sse_starlette.sse import EventSourceResponse

from app import db
from app.core import rag
from app.models import Course
from app.schemas import ChatRequest

router = APIRouter(tags=["chat"])


@router.post("/chat")
async def chat(request: ChatRequest) -> EventSourceResponse:
    with Session(db.engine) as session:
        if session.get(Course, request.course_id) is None:
            raise HTTPException(404, "课程不存在")

    history = [turn.model_dump() for turn in request.history]

    async def event_stream() -> AsyncIterator[dict]:
        try:
            with Session(db.engine) as session:
                async for kind, payload in rag.stream_answer(
                    session, request.course_id, request.question, history
                ):
                    if kind == "citations":
                        yield {
                            "event": "citations",
                            "data": json.dumps(payload, ensure_ascii=False),
                        }
                    else:
                        yield {
                            "event": "delta",
                            "data": json.dumps({"text": payload}, ensure_ascii=False),
                        }
        except Exception as exc:  # noqa: BLE001  边界：把可读错误发给前端
            yield {"event": "error", "data": json.dumps({"message": str(exc)}, ensure_ascii=False)}
        finally:
            yield {"event": "done", "data": "{}"}

    return EventSourceResponse(event_stream())
