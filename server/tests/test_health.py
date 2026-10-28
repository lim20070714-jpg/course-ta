from fastapi.testclient import TestClient

from app.main import _WEB_DIST, app


def test_health() -> None:
    with TestClient(app) as client:
        resp = client.get("/api/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


def test_api_index() -> None:
    with TestClient(app) as client:
        resp = client.get("/api")
        assert resp.status_code == 200
        assert resp.json()["name"] == "CourseTA API"


def test_root_without_build_is_json() -> None:
    if (_WEB_DIST / "index.html").is_file():
        return  # 有构建产物时 "/" 由前端页面接管，见 test_spa_serving
    with TestClient(app) as client:
        resp = client.get("/")
        assert resp.status_code == 200
        assert resp.json()["name"] == "CourseTA API"


def test_spa_serving(tmp_path) -> None:
    """挂载后前端页面与静态资源同源可用，未知 API 仍返回 404。"""
    if not (_WEB_DIST / "index.html").is_file():
        return
    with TestClient(app) as client:
        index = client.get("/")
        assert index.status_code == 200
        assert "text/html" in index.headers["content-type"]
        deep = client.get("/some/client/route")
        assert deep.status_code == 200
        assert "text/html" in deep.headers["content-type"]
        assert client.get("/api/not-a-real-endpoint").status_code == 404
