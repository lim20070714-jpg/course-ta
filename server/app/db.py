from sqlmodel import SQLModel, create_engine

from app.config import settings
from app.core.kinds import detect_kind

_DB_FILE = settings.data_dir / "course_ta.db"
engine = create_engine(
    f"sqlite:///{_DB_FILE.as_posix()}",
    connect_args={"check_same_thread": False},
)


def _ensure_material_kind() -> None:
    """给旧库补 Material.kind 列；仅新建列时按文件名回填一次。"""
    with engine.begin() as conn:
        cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(material)")}
        if "kind" in cols:
            return
        conn.exec_driver_sql(
            "ALTER TABLE material ADD COLUMN kind VARCHAR NOT NULL DEFAULT 'other'"
        )
        rows = conn.exec_driver_sql("SELECT id, filename FROM material").fetchall()
        for material_id, filename in rows:
            conn.exec_driver_sql(
                "UPDATE material SET kind = ? WHERE id = ?",
                (detect_kind(str(filename)), material_id),
            )


def _ensure_course_exam_date() -> None:
    """给旧库补 Course.exam_date 列（考试冲刺模式）；空值表示未设置考试日期。"""
    with engine.begin() as conn:
        cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(course)")}
        if "exam_date" in cols:
            return
        conn.exec_driver_sql("ALTER TABLE course ADD COLUMN exam_date DATETIME")


def _ensure_material_pages() -> None:
    """给旧库补 Material.pages 列（图片页清单）；默认空数组。"""
    with engine.begin() as conn:
        cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(material)")}
        if "pages" in cols:
            return
        conn.exec_driver_sql("ALTER TABLE material ADD COLUMN pages VARCHAR NOT NULL DEFAULT '[]'")


def init_db() -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    import app.models  # noqa: F401  导入以注册表结构

    SQLModel.metadata.create_all(engine)
    _ensure_material_kind()
    _ensure_course_exam_date()
    _ensure_material_pages()
