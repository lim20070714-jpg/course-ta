"""服务重启后把「还在进行中」的状态收成可操作的结果。

后台任务挂在 FastAPI 的 BackgroundTasks 上，只活在进程里：解析 / 总结 / 图谱 / 批改跑到
一半时重启，任务不会自己重跑，但库里的状态还停在 ingesting / generating / grading。
前端于是永远转圈，改名与删除被忙碌守卫一直挡成 409，模考则卡在「已交卷」既不能改作答
也不能重新交卷。启动时一次性复位，把每种情况都变成用户点得动的下一步。
"""

from sqlmodel import Session, select

from app import db
from app.models import CourseGraph, Material, MockExam, Summary

# 状态里看不出是崩溃还是正常结束，所以错误信息要写明白「是重启打断的」
INTERRUPTED = "处理被服务重启打断"


def reset_interrupted_jobs() -> dict[str, int]:
    """返回每类被复位的行数（供启动日志与测试断言）。"""
    counts = {"material": 0, "summary": 0, "graph": 0, "exam": 0}
    with Session(db.engine) as session:
        for row in session.exec(
            select(Material).where(  # type: ignore[attr-defined]
                Material.status.in_(("pending", "ingesting"))
            )
        ).all():
            row.status = "failed"
            row.error = f"{INTERRUPTED}：原件还在磁盘上，删掉这份重新上传即可"
            session.add(row)
            counts["material"] += 1

        for row in session.exec(
            select(Summary).where(Summary.status == "generating")  # type: ignore[attr-defined]
        ).all():
            row.status = "failed"
            row.error = f"{INTERRUPTED}，点「重新生成」再来一次"
            session.add(row)
            counts["summary"] += 1

        for row in session.exec(
            select(CourseGraph).where(CourseGraph.status == "generating")  # type: ignore[attr-defined]
        ).all():
            row.status = "failed"
            row.error = f"{INTERRUPTED}，点「重新生成」再来一次"
            session.add(row)
            counts["graph"] += 1

        # 批改丢了但作答逐题存在 ExamAnswer 里：退回 running 而不是 failed，
        # 让学生能接着改、能重新交卷，而不是整场作废。
        for row in session.exec(
            select(MockExam).where(MockExam.status == "grading")  # type: ignore[attr-defined]
        ).all():
            row.status = "running"
            row.error = f"{INTERRUPTED}，你的作答都还在，可以重新交卷"
            session.add(row)
            counts["exam"] += 1

        session.commit()
    return counts
