from app.core.tools import solve_equation, verify_equal


def test_solve_linear_equation() -> None:
    assert solve_equation("2*x + 4 = 0", "x") == ["-2"]


def test_solve_with_implicit_multiplication() -> None:
    assert solve_equation("2x - 6 = 0", "x") == ["3"]


def test_solve_quadratic() -> None:
    assert set(solve_equation("x**2 - 5*x + 6 = 0", "x")) == {"2", "3"}


def test_verify_equal_true() -> None:
    assert verify_equal("(x + 1)**2", "x**2 + 2*x + 1")


def test_verify_equal_false() -> None:
    assert not verify_equal("x + 1", "x + 2")
