from sympy import Eq, simplify, solve, sympify
from sympy.parsing.sympy_parser import (
    implicit_multiplication_application,
    parse_expr,
    standard_transformations,
)

_TRANSFORMS = standard_transformations + (implicit_multiplication_application,)


def _parse(expr: str):
    return parse_expr(expr, transformations=_TRANSFORMS)


def solve_equation(equation: str, var: str = "x") -> list[str]:
    """求解一元方程，例如 '2*x + 4 = 0'。支持隐式乘法（'2x + 4 = 0'），返回解的字符串列表。"""
    if "=" in equation:
        lhs, rhs = equation.split("=", 1)
        eq = Eq(_parse(lhs), _parse(rhs))
    else:
        eq = Eq(_parse(equation), 0)
    return [str(sol) for sol in solve(eq, sympify(var))]


def verify_equal(a: str, b: str) -> bool:
    """判断两个表达式化简后是否恒等，可用于检查推导步骤是否正确。"""
    return bool(simplify(_parse(a) - _parse(b)) == 0)
