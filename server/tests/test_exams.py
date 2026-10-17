"""限时模考：组卷、计时、作答保存、交卷批改与成绩单。"""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine, select
from sqlmodel.pool import StaticPool

import app.db as db_module
from app.core import exams as core
from app.main import app
from app.models import Attempt, Course, ExamAnswer, Material, MockExam, Problem


@pytest.fixture()
def engine():
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(eng)
    return eng


@pytest.fixture()
def client(engine, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setattr(db_module, "engine", engine)
    with Session(engine) as session:
        session.add(Course(id=1, name="电路", created_at=datetime.now(UTC)))
        session.add(Material(id=1, course_id=1, filename="期末卷.pdf", stored_path="x", kind="exam"))
        # 6 题：4 题有参考答案（可组卷），2 题没有
        for i in range(1, 7):
            session.add(
                Problem(
                    id=i,
                    course_id=1,
                    material_id=1,
                    page=i,
                    number=f"第{i}题",
                    stem=f"题干 {i}：求 $v_o$。",
                    answer=f"参考答案 {i}" if i <= 4 else "",
                    knowledge='["戴维南定理"]' if i <= 2 else '["叠加定理"]',
                    created_at=datetime.now(UTC),
                )
            )
        session.commit()
    yield TestClient(app)


def make_problems(*, answers: dict[int, str], stems: dict[int, str] | None = None) -> list[Problem]:
    stems = stems or {}
    return [
        Problem(
            id=pid,
            course_id=1,
            stem=stems.get(pid, f"题干 {pid}"),
            answer=answer,
            knowledge="[]",
        )
        for pid, answer in answers.items()
    ]


def test_gradeable_requires_stem_and_answer() -> None:
    problems = make_problems(answers={1: "有答案", 2: "", 3: "  "})
    problems.append(Problem(id=4, course_id=1, stem="", answer="有答案", knowledge="[]"))
    assert [p.id for p in core.gradeable(problems)] == [1]


def test_assemble_limits_count_and_falls_back_to_pool() -> None:
    problems = make_problems(answers={i: "答案" for i in range(1, 11)})
    picked = core.assemble(problems, 4, seed=7)
    assert len(picked) == 4
    # 同一 seed 复现同一份卷子
    assert [p.id for p in picked] == [p.id for p in core.assemble(problems, 4, seed=7)]
    # 候选不足则全取
    assert len(core.assemble(problems, 50)) == 10


def test_parse_problem_ids_tolerates_dirty_json() -> None:
    assert core.parse_problem_ids("[3, 1, 2]") == [3, 1, 2]
    assert core.parse_problem_ids("") == []
    assert core.parse_problem_ids("not json") == []
    assert core.parse_problem_ids('[1, "x", null, 4]') == [1, 4]


def test_score_percent_weighting() -> None:
    assert core.score_percent([]) == 0.0
    assert core.score_percent(["correct", "correct"]) == 100.0
    assert core.score_percent(["correct", "partial", "wrong", "unanswered"]) == 37.5
    assert core.score_percent(["unknown", "wrong"]) == 0.0


def test_knowledge_of_parses_tags() -> None:
    problem = Problem(id=1, course_id=1, stem="s", answer="a", knowledge='["戴维南定理", "叠加"]')
    assert core.knowledge_of(problem) == ["戴维南定理", "叠加"]


def fake_llm(verdict: str) -> object:
    async def _complete(messages: list[dict], **_: object) -> str:
        return f"【判定】{verdict}\n\n步骤反馈：关键点正确。"

    return _complete


def picked_ids(client: TestClient, exam_id: int) -> list[int]:
    """组卷是随机抽样，测试里以实际抽到的题号为准。"""
    detail = client.get(f"/api/mock-exams/{exam_id}").json()
    return [item["problem_id"] for item in detail["items"]]


def test_create_exam_only_picks_gradeable_problems(client: TestClient) -> None:
    resp = client.post(
        "/api/courses/1/mock-exams", json={"title": "模考 A", "count": 10, "duration_min": 30}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ready"
    assert body["count"] == 4  # 只有 4 题带参考答案
    assert body["seconds_left"] == 30 * 60
    with Session(db_module.engine) as session:
        exam = session.get(MockExam, body["id"])
        assert exam is not None
        assert core.parse_problem_ids(exam.problem_ids) == [1, 2, 3, 4]


def test_create_exam_filters_by_knowledge_and_material(client: TestClient) -> None:
    body = client.post(
        "/api/courses/1/mock-exams",
        json={"count": 10, "knowledge": "戴维南定理", "material_id": 1},
    ).json()
    assert body["count"] == 2


def test_create_exam_rejects_empty_pool(client: TestClient) -> None:
    resp = client.post("/api/courses/1/mock-exams", json={"count": 5, "knowledge": "不存在的知识点"})
    assert resp.status_code == 400
    assert "组卷" in resp.json()["detail"]


def test_detail_withholds_reference_answer_until_done(client: TestClient) -> None:
    body = client.post("/api/courses/1/mock-exams", json={"count": 4}).json()
    detail = client.get(f"/api/mock-exams/{body['id']}").json()
    assert all(item["answer"] == "" for item in detail["items"])
    assert all(item["stem"] for item in detail["items"])
    assert [item["problem_id"] for item in detail["items"]] == [1, 2, 3, 4]


def test_start_sets_deadline_and_is_idempotent(client: TestClient) -> None:
    exam_id = client.post("/api/courses/1/mock-exams", json={"count": 4, "duration_min": 45}).json()["id"]
    started = client.post(f"/api/mock-exams/{exam_id}/start").json()
    assert started["status"] == "running"
    assert started["seconds_left"] > 44 * 60
    again = client.post(f"/api/mock-exams/{exam_id}/start").json()
    # 重复开考不重置计时
    assert again["started_at"] == started["started_at"]


def test_save_answer_then_submit_grades_with_llm(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(core.llm, "complete", fake_llm("正确"))
    exam_id = client.post("/api/courses/1/mock-exams", json={"count": 4, "duration_min": 60}).json()["id"]
    client.post(f"/api/mock-exams/{exam_id}/start")

    saved = client.put(
        f"/api/mock-exams/{exam_id}/answers/1", json={"answer_text": "$v_o = 3V$"}
    ).json()
    assert saved["exam"]["answered"] == 1
    assert saved["items"][0]["answer_text"] == "$v_o = 3V$"

    submitted = client.post(f"/api/mock-exams/{exam_id}/submit").json()
    assert submitted["status"] == "grading"

    done = client.get(f"/api/mock-exams/{exam_id}").json()
    assert done["exam"]["status"] == "done"
    assert done["exam"]["score"] == 25.0  # 只答对 1/4
    assert done["items"][0]["verdict"] == "correct"
    assert done["items"][1]["verdict"] == "unanswered"
    # 交卷后参考答案才下发
    assert done["items"][0]["answer"] == "参考答案 1"


def test_unanswered_problems_enter_wrongbook(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(core.llm, "complete", fake_llm("错误"))
    exam_id = client.post("/api/courses/1/mock-exams", json={"count": 2}).json()["id"]
    ids = picked_ids(client, exam_id)
    client.post(f"/api/mock-exams/{exam_id}/start")
    client.put(f"/api/mock-exams/{exam_id}/answers/{ids[0]}", json={"answer_text": "我的过程"})
    client.post(f"/api/mock-exams/{exam_id}/submit")

    wrong = client.get("/api/courses/1/wrongbook").json()
    assert {item["id"] for item in wrong} == set(ids)
    with Session(db_module.engine) as session:
        attempts = session.exec(select(Attempt).where(Attempt.problem_id == ids[1])).all()
        assert len(attempts) == 1
        assert attempts[0].verdict == "wrong"


def test_partial_verdict_scores_half(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(core.llm, "complete", fake_llm("部分正确"))
    exam_id = client.post("/api/courses/1/mock-exams", json={"count": 2}).json()["id"]
    ids = picked_ids(client, exam_id)
    client.post(f"/api/mock-exams/{exam_id}/start")
    for pid in ids:
        client.put(f"/api/mock-exams/{exam_id}/answers/{pid}", json={"answer_text": "写了一半"})
    client.post(f"/api/mock-exams/{exam_id}/submit")
    assert client.get(f"/api/mock-exams/{exam_id}").json()["exam"]["score"] == 50.0


def test_late_submission_is_flagged(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(core.llm, "complete", fake_llm("正确"))
    exam_id = client.post("/api/courses/1/mock-exams", json={"count": 1, "duration_min": 5}).json()["id"]
    with Session(db_module.engine) as session:
        exam = session.get(MockExam, exam_id)
        assert exam is not None
        exam.started_at = datetime.now(UTC) - timedelta(minutes=10)
        exam.deadline_at = datetime.now(UTC) - timedelta(minutes=1)
        exam.status = "running"
        session.add(exam)
        session.commit()

    submitted = client.post(f"/api/mock-exams/{exam_id}/submit").json()
    assert submitted["late"] is True
    assert submitted["seconds_left"] == 0


def test_cannot_change_answers_after_submit(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(core.llm, "complete", fake_llm("正确"))
    exam_id = client.post("/api/courses/1/mock-exams", json={"count": 1}).json()["id"]
    pid = picked_ids(client, exam_id)[0]
    client.post(f"/api/mock-exams/{exam_id}/start")
    assert client.put(f"/api/mock-exams/{exam_id}/answers/{pid}", json={"answer_text": "答"}).status_code == 200
    client.post(f"/api/mock-exams/{exam_id}/submit")

    assert client.put(f"/api/mock-exams/{exam_id}/answers/{pid}", json={"answer_text": "改答案"}).status_code == 409
    assert client.post(f"/api/mock-exams/{exam_id}/submit").status_code == 409


def test_answer_for_foreign_problem_rejected(client: TestClient) -> None:
    exam_id = client.post("/api/courses/1/mock-exams", json={"count": 1}).json()["id"]
    assert client.put(f"/api/mock-exams/{exam_id}/answers/5", json={"answer_text": "x"}).status_code == 404


def test_list_and_delete(client: TestClient) -> None:
    exam_id = client.post("/api/courses/1/mock-exams", json={"count": 2}).json()["id"]
    rows = client.get("/api/courses/1/mock-exams").json()
    assert [r["id"] for r in rows] == [exam_id]
    assert client.delete(f"/api/mock-exams/{exam_id}").json() == {"status": "deleted"}
    assert client.get(f"/api/mock-exams/{exam_id}").status_code == 404
    with Session(db_module.engine) as session:
        assert session.exec(select(ExamAnswer).where(ExamAnswer.exam_id == exam_id)).all() == []
