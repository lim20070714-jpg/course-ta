from sqlmodel import SQLModel, create_engine

from app.config import settings

_DB_FILE = settings.data_dir / "course_ta.db"
engine = create_engine(
    f"sqlite:///{_DB_FILE.as_posix()}",
    connect_args={"check_same_thread": False},
)


def init_db() -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    import app.models  # noqa: F401  导入以注册表结构

    SQLModel.metadata.create_all(engine)
