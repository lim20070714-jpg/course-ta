import pytest
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, create_engine
from sqlmodel.pool import StaticPool

from app import db as db_module
from app.core import compute
from app.main import app


def test_parse_input_plain_implicit_multiplication() -> None:
    symbols = compute.build_symbols([])
    assert str(compute.parse_input("2x + 1", symbols)) == "2*x + 1"


def test_parse_input_latex() -> None:
    symbols = compute.build_symbols([])
    assert str(compute.parse_input(r"\frac{x^2+1}{x-1}", symbols)) == "(x**2 + 1)/(x - 1)"


def test_parse_input_empty_raises() -> None:
    with pytest.raises(ValueError):
        compute.parse_input("   ", compute.build_symbols([]))


def test_symbol_assumption_positive() -> None:
    spec = [{"name": "a", "kind": "positive"}]
    result = compute.evaluate({"expr": "sqrt(a^2)", "op": "simplify", "symbols": spec})
    assert result["plain"] == "a"


def test_evaluate_diff() -> None:
    result = compute.evaluate({"expr": "x^3", "op": "diff", "var": "x"})
    assert result["plain"] == "3*x**2"


def test_evaluate_integrate_definite() -> None:
    result = compute.evaluate(
        {"expr": "x^2", "op": "integrate", "var": "x", "lower": "0", "upper": "1"}
    )
    assert result["plain"] == "1/3"


def test_evaluate_integrate_latex_definite() -> None:
    result = compute.evaluate({"expr": r"\int_0^{+\infty} e^{-x^2}\,dx", "op": "integrate", "var": "x"})
    assert result["plain"] == "sqrt(pi)/2"


def test_evaluate_limit() -> None:
    result = compute.evaluate({"expr": "sin(x)/x", "op": "limit", "var": "x", "point": "0"})
    assert result["plain"] == "1"


def test_evaluate_laplace() -> None:
    result = compute.evaluate({"expr": "exp(-2t)", "op": "laplace", "var": "t"})
    assert result["plain"] == "1/(s + 2)"


def test_evaluate_solve_equation() -> None:
    result = compute.evaluate({"expr": "x^2 - 3x + 2 = 0", "op": "solve", "var": "x"})
    assert result["plain"] == "1, 2"


def test_evaluate_matrix_det() -> None:
    result = compute.evaluate({"expr": "[[1,2],[3,4]]", "op": "det"})
    assert result["plain"] == "-2"


def test_evaluate_matrix_eigen() -> None:
    result = compute.evaluate({"expr": "[[2,0],[0,3]]", "op": "eigen"})
    assert "2" in result["plain"] and "3" in result["plain"]


def test_evaluate_residue_complex() -> None:
    result = compute.evaluate({"expr": "1/(z^2+1)", "op": "residue", "var": "z", "point": "i"})
    assert result["plain"] == "-I/2"
    assert result["approx"] == "-0.5*I"


def test_evaluate_numeric_approx() -> None:
    result = compute.evaluate({"expr": "pi", "op": "simplify"})
    assert result["approx"] == "3.14159"


def test_evaluate_unknown_op_raises() -> None:
    with pytest.raises(ValueError, match="不支持的操作"):
        compute.evaluate({"expr": "x", "op": "fly"})


def _client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(db_module, "engine", engine)
    return TestClient(app)


def test_compute_api(monkeypatch: pytest.MonkeyPatch) -> None:
    with _client(monkeypatch) as client:
        resp = client.post("/api/compute/evaluate", json={"expr": "x^2", "op": "diff", "var": "x"})
        assert resp.status_code == 200
        assert resp.json()["plain"] == "2*x"
        bad = client.post("/api/compute/evaluate", json={"expr": "x", "op": "fly"})
        assert bad.status_code == 422


def test_formulas_seed_and_crud(monkeypatch: pytest.MonkeyPatch) -> None:
    with _client(monkeypatch) as client:
        presets = client.get("/api/formulas").json()
        assert len(presets) >= 20
        assert all(item["preset"] for item in presets)

        created = client.post(
            "/api/formulas",
            json={"title": "勾股定理", "latex": "a^2+b^2=c^2", "category": "自定义"},
        ).json()
        assert created["preset"] is False

        updated = client.put(f"/api/formulas/{created['id']}", json={"note": "直角三角形"}).json()
        assert updated["note"] == "直角三角形"
        assert updated["title"] == "勾股定理"

        assert client.delete(f"/api/formulas/{created['id']}").json() == {"status": "ok"}
        assert client.delete(f"/api/formulas/{created['id']}").status_code == 404
