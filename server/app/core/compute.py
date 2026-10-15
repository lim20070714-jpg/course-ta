"""计算台：sympy 符号计算内核（支持 LaTeX 与普通数学语法输入）。

按通用数学分支组织：化简与变换式、微积分（含定积分/偏导/泰勒展开）、
积分变换（傅里叶/拉普拉斯）、线性代数（矩阵运算）、复变函数（留数/共轭/模/辐角）。
"""

import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import sympy
from sympy.parsing.latex import parse_latex
from sympy.parsing.sympy_parser import (
    convert_xor,
    implicit_multiplication_application,
    parse_expr,
    rationalize,
    standard_transformations,
)

_TIMEOUT_S = 20.0
_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="compute")

OPS = {
    "simplify", "expand", "factor", "apart", "trigsimp",
    "diff", "partial", "integrate", "limit", "series", "taylor", "solve",
    "fourier", "inverse_fourier", "laplace", "inverse_laplace",
    "det", "inv", "transpose", "rank", "rref", "eigen",
    "conjugate", "expand_complex", "abs", "arg", "re", "im", "residue",
}

_MATRIX_OPS = {"det", "inv", "transpose", "rank", "rref", "eigen"}

_DEFAULT_SYMBOL_NAMES = ("x", "y", "z", "t", "s", "n", "a", "b", "c", "k", "m", "w")
_CONSTANTS = {"pi": sympy.pi, "e": sympy.E, "i": sympy.I, "oo": sympy.oo}

_ASSUMPTION_KINDS = {
    "real": {"real": True},
    "positive": {"positive": True},
    "negative": {"negative": True},
    "integer": {"integer": True},
    "complex": {},
}


def build_symbols(specs: list[dict[str, str]]) -> dict[str, sympy.Symbol]:
    """默认符号 + 用户自定义符号（可带 实数/正数/负数/整数/复数 假设）。"""
    symbols = {name: sympy.Symbol(name) for name in _DEFAULT_SYMBOL_NAMES}
    for spec in specs:
        name = str(spec.get("name", "")).strip()
        if not name or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_{}]*|\\?[a-zA-Z]+", name):
            continue
        clean = name.lstrip("\\")
        kind = _ASSUMPTION_KINDS.get(str(spec.get("kind", "complex")), {})
        symbols[clean] = sympy.Symbol(clean, **kind)
    return symbols


def _local_dict(symbols: dict[str, sympy.Symbol]) -> dict[str, Any]:
    local: dict[str, Any] = dict(_CONSTANTS)
    local.update(symbols)
    local.update({"E": sympy.E, "I": sympy.I})
    return local


def _apply_symbols(expr: Any, symbols: dict[str, sympy.Symbol]) -> Any:
    """把解析出的匿名符号替换为带假设的符号，并映射 e/i/pi 常量（parse_latex 不做这些）。"""
    if not isinstance(expr, sympy.Basic):
        return expr
    subs: dict[Any, Any] = {}
    for s in expr.free_symbols:
        if s.name in symbols:
            subs[s] = symbols[s.name]
        elif s.name in _CONSTANTS:
            subs[s] = _CONSTANTS[s.name]
    return expr.xreplace(subs) if subs else expr


def parse_input(expr: str, symbols: dict[str, sympy.Symbol]) -> Any:
    """解析表达式：含反斜杠按 LaTeX 解析，否则按普通语法（支持 2x 这类隐式乘号）。"""
    expr = expr.strip().strip("$")
    if not expr:
        raise ValueError("表达式为空")
    if "\\" in expr:
        try:
            parsed = parse_latex(expr, strict=False)
        except Exception as exc:
            raise ValueError(f"LaTeX 解析失败：{exc}") from exc
        return _apply_symbols(parsed, symbols)
    try:
        return parse_expr(
            expr,
            local_dict=_local_dict(symbols),
            transformations=standard_transformations
            + (implicit_multiplication_application, convert_xor, rationalize),
        )
    except Exception as exc:
        braced = expr.replace("{", "(").replace("}", ")")
        if braced == expr:
            raise ValueError(f"表达式解析失败：{exc}") from exc
        try:  # 混用 LaTeX 花括号的普通输入，如 e^{-x^2}
            return parse_expr(
                braced,
                local_dict=_local_dict(symbols),
                transformations=standard_transformations
                + (implicit_multiplication_application, convert_xor, rationalize),
            )
        except Exception as inner:
            raise ValueError(f"表达式解析失败：{inner}") from inner


def _parse_value(text: str, symbols: dict[str, sympy.Symbol]) -> Any:
    text = text.strip()
    if not text:
        raise ValueError("缺少参数值")
    return parse_input(text, symbols)


_FREQ_NAMES = ("omega", "w")


def _fourier_transform(expr: Any, var: sympy.Symbol, symbols: dict[str, sympy.Symbol]) -> Any:
    """傅里叶变换，角频率约定 F(ω)=∫f(t)e^{-iωt}dt（教材与工程通用）。"""
    if not expr.has(var) and len(expr.free_symbols) == 1:
        var = next(iter(expr.free_symbols))
    omega = symbols.get("omega") or sympy.Symbol("omega")
    k = sympy.Symbol("k")
    result = sympy.fourier_transform(expr, var, k)
    if result.has(sympy.FourierTransform):
        fallback = sympy.integrate(
            expr * sympy.exp(-sympy.I * omega * var), (var, -sympy.oo, sympy.oo)
        )
        if fallback.has(sympy.Integral):
            raise ValueError("求不出该函数的解析傅里叶变换（可尝试化简表达式或改用拉普拉斯变换）")
        return fallback
    return result.subs(k, omega / (2 * sympy.pi))


def _inverse_fourier_transform(expr: Any, symbols: dict[str, sympy.Symbol]) -> Any:
    """逆傅里叶变换 f(t)=(1/2π)∫F(ω)e^{iωt}dω；自动识别频率符号（\\omega 或 w）。"""
    freq = None
    for name in _FREQ_NAMES:
        symbol = symbols.get(name) or sympy.Symbol(name)
        if expr.has(symbol):
            freq = symbol
            break
    if freq is None:
        raise ValueError("表达式中找不到频率变量（请用 w 或 \\omega 表示频率）")
    t = symbols.get("t") or sympy.Symbol("t")
    k = sympy.Symbol("k")
    result = sympy.inverse_fourier_transform(expr.subs(freq, 2 * sympy.pi * k), k, t)
    if result.has(sympy.InverseFourierTransform):
        fallback = sympy.integrate(
            expr * sympy.exp(sympy.I * freq * t), (freq, -sympy.oo, sympy.oo)
        ) / (2 * sympy.pi)
        if fallback.has(sympy.Integral):
            raise ValueError("求不出该函数的解析逆傅里叶变换（可尝试化简表达式）")
        return fallback
    return result


def evaluate(req: dict[str, Any]) -> dict[str, str]:
    """执行一次计算。req: {expr, op, var, point, lower, upper, order, symbols}。"""
    op = str(req.get("op", "simplify"))
    if op not in OPS:
        raise ValueError(f"不支持的操作：{op}")
    result_holder: list[Any] = []

    def work() -> None:
        symbols = build_symbols(req.get("symbols") or [])
        raw = str(req.get("expr", ""))
        var_name = str(req.get("var") or "x").strip() or "x"
        var = symbols.get(var_name.lstrip("\\")) or sympy.Symbol(var_name)
        order = max(1, int(req.get("order") or 1))
        point = _parse_value(str(req.get("point", "")), symbols) if str(req.get("point", "")).strip() else 0
        lower_s = str(req.get("lower", "")).strip()
        upper_s = str(req.get("upper", "")).strip()

        if op == "solve" and "=" in raw and "\\" not in raw:
            lhs, rhs = raw.split("=", 1)
            equation = sympy.Eq(
                parse_input(lhs, symbols), parse_input(rhs, symbols)
            )
            expr = equation
        elif op in _MATRIX_OPS:
            expr = _parse_matrix(raw, symbols)
        else:
            expr = parse_input(raw, symbols)

        result_holder.append(_dispatch(op, expr, var, order, point, lower_s, upper_s, symbols))

    future = _EXECUTOR.submit(work)
    try:
        future.result(timeout=_TIMEOUT_S)
    except TimeoutError as exc:
        raise ValueError(f"计算超时（{int(_TIMEOUT_S)} 秒），请简化表达式或换一种方法") from exc
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"计算失败：{exc}") from exc
    return _format_result(result_holder[0])


def _dispatch(
    op: str,
    expr: Any,
    var: sympy.Symbol,
    order: int,
    point: Any,
    lower_s: str,
    upper_s: str,
    symbols: dict[str, sympy.Symbol],
) -> Any:
    if op == "simplify":
        return sympy.simplify(expr)
    if op == "expand":
        return sympy.expand(expr)
    if op == "factor":
        return sympy.factor(expr)
    if op == "apart":
        return sympy.apart(expr, var)
    if op == "trigsimp":
        return sympy.trigsimp(expr)
    if op == "diff" or op == "partial":
        return sympy.diff(expr, var, order)
    if op == "integrate":
        if isinstance(expr, sympy.Integral):
            return expr.doit()
        if lower_s and upper_s:
            lo = _parse_value(lower_s, symbols)
            hi = _parse_value(upper_s, symbols)
            result = sympy.integrate(expr, (var, lo, hi))
            if result.has(sympy.Integral) and not result.free_symbols:
                try:
                    numeric = sympy.N(result, 10)
                except Exception:  # noqa: BLE001  数值回退失败则保留符号结果
                    return result
                if not numeric.has(sympy.Integral):
                    return numeric
            return result
        return sympy.integrate(expr, var)
    if op == "limit":
        return sympy.limit(expr, var, point)
    if op in ("series", "taylor"):
        return sympy.series(expr, var, point, order).removeO()
    if op == "solve":
        equation = expr if isinstance(expr, sympy.Eq) else sympy.Eq(expr, 0)
        return sympy.solve(equation, var)
    if op == "fourier":
        return _fourier_transform(expr, var, symbols)
    if op == "inverse_fourier":
        return _inverse_fourier_transform(expr, symbols)
    if op == "laplace":
        return sympy.laplace_transform(expr, var, sympy.Symbol("s"), noconds=True)
    if op == "inverse_laplace":
        return sympy.inverse_laplace_transform(expr, var, sympy.Symbol("t"))
    if op == "det":
        return expr.det() if isinstance(expr, sympy.MatrixBase) else expr
    if op == "inv":
        return expr.inv()
    if op == "transpose":
        return expr.T
    if op == "rank":
        return expr.rank()
    if op == "rref":
        return expr.rref()[0]
    if op == "eigen":
        return expr.eigenvals()
    if op == "conjugate":
        return sympy.conjugate(expr)
    if op == "expand_complex":
        return sympy.expand_complex(expr)
    if op == "abs":
        return sympy.Abs(expr)
    if op == "arg":
        return sympy.arg(expr)
    if op == "re":
        return sympy.re(expr)
    if op == "im":
        return sympy.im(expr)
    if op == "residue":
        return sympy.residue(expr, var, point)
    raise ValueError(f"不支持的操作：{op}")


_DET_WRAPPER_RE = re.compile(
    r"^\s*(?:\\operatorname\s*\{det\}|\\mathrm\s*\{det\}|\\det|det)\s*"
)
_MATRIX_ENV_RE = re.compile(
    r"\\begin\{(?P<env>[a-zA-Z*]+)\}(?P<body>.*?)\\end\{(?P=env)\}", re.DOTALL
)


def _strip_equation_tail(raw: str) -> str:
    """整行粘贴公式库条目时（如 \\det(...)=ad-bc）矩阵操作只取等号左边。"""
    if "=" in raw:
        head = raw.split("=", 1)[0].strip()
        if head:
            return head
    return raw


def _strip_det_wrapper(raw: str) -> str:
    """剥掉 \\det / det(...) 包装，拿到其中的矩阵。"""
    stripped = _DET_WRAPPER_RE.sub("", raw, count=1)
    if stripped == raw:
        return raw
    stripped = stripped.strip()
    for left, right in ((r"\left(", r"\right)"), ("(", ")")):
        if stripped.startswith(left) and stripped.endswith(right):
            return stripped[len(left):-len(right)].strip()
    return stripped


def _matrix_env_fallback(raw: str, symbols: dict[str, sympy.Symbol]) -> Any | None:
    """按 & 与 \\\\ 手工拆分 \\begin{...} 环境，兜底 lark 后端不认的形式（matrix/array）。"""
    match = _MATRIX_ENV_RE.search(raw)
    if match is None:
        return None
    leftover = raw[: match.start()] + raw[match.end():]
    leftover = leftover.replace(r"\left(", "").replace(r"\right)", "").replace("(", "").replace(")", "")
    if leftover.strip():  # 环境不占满整个表达式（如矩阵相加）时不兜底，避免丢项
        return None
    body = match.group("body")
    if match.group("env") == "array":
        body = re.sub(r"^\s*\{[^}]*\}", "", body, count=1)
    rows = [row for row in body.split(r"\\") if row.strip()]
    if not rows:
        raise ValueError("矩阵环境里没有内容")
    values = [
        [parse_input(cell, symbols) if cell.strip() else sympy.Integer(0) for cell in row.split("&")]
        for row in rows
    ]
    if len({len(row) for row in values}) != 1:
        raise ValueError(r"矩阵每行的元素个数不一致，请检查 & 与 \\ 的使用")
    return sympy.Matrix(values)


def _parse_matrix(raw: str, symbols: dict[str, sympy.Symbol]) -> Any:
    raw = raw.strip().strip("$")
    raw = _strip_equation_tail(raw)
    raw = _strip_det_wrapper(raw)
    raw = raw.replace(r"\begin{vmatrix}", r"\begin{pmatrix}")  # 竖线矩阵按普通矩阵取，行列式由操作决定
    raw = raw.replace(r"\end{vmatrix}", r"\end{pmatrix}")
    if "matrix" in raw or "array" in raw:
        parsed = None
        try:
            parsed = parse_latex(raw, backend="lark")  # ANTLR 语法不支持矩阵环境，用 lark 后端
        except Exception:  # noqa: BLE001  解析失败交给手工兜底
            parsed = None
        if isinstance(parsed, sympy.MatrixBase):
            return _apply_symbols(parsed, symbols)
        fallback = _matrix_env_fallback(raw, symbols)
        if fallback is not None:
            return _apply_symbols(fallback, symbols)
        if parsed is not None:  # lark 已把整体算式（如 \det(...)）算成标量
            return parsed
    try:
        value = sympy.sympify(raw, locals=_local_dict(symbols))
        if isinstance(value, sympy.MatrixBase):
            return _apply_symbols(value, symbols)
        return sympy.Matrix(value)
    except Exception as exc:
        raise ValueError(
            f"矩阵解析失败：{exc}（可用 [[1,2],[3,4]] 或 \\begin{{pmatrix}}…\\end{{pmatrix}}）"
        ) from exc


def _format_result(result: Any) -> dict[str, str]:
    if isinstance(result, dict):  # eigenvals: {特征值: 重数}
        parts = [
            f"\\lambda_{{{i+1}}} = {sympy.latex(val)}\\;(重数 {mult})"
            for i, (val, mult) in enumerate(result.items())
        ]
        latex = ",\\quad ".join(parts)
        plain = ", ".join(f"λ_{i + 1} = {val} (×{mult})" for i, (val, mult) in enumerate(result.items()))
        return {"latex": latex, "plain": plain, "approx": ""}
    if isinstance(result, (list, tuple, set)):
        items = sorted(result, key=lambda x: sympy.default_sort_key(x)) if isinstance(result, set) else list(result)
        latex = ",\\quad ".join(sympy.latex(x) for x in items)
        plain = ", ".join(str(x) for x in items)
        return {"latex": latex, "plain": plain, "approx": ""}
    latex = sympy.latex(result)
    plain = sympy.sstr(result)
    approx = ""
    if (
        isinstance(result, sympy.Expr)
        and not isinstance(result, sympy.MatrixExpr)
        and not result.free_symbols
    ):
        numeric = sympy.N(result, 6)
        text = sympy.sstr(numeric)
        if text != plain:
            approx = text
    return {"latex": latex, "plain": plain, "approx": approx}


PRESET_FORMULAS: list[dict[str, str]] = [
    # —— 微积分 ——
    {"title": "微积分基本定理", "category": "微积分",
     "latex": r"\int_a^b f'(x)\,dx = f(b) - f(a)",
     "note": "牛顿-莱布尼茨公式"},
    {"title": "分部积分", "category": "微积分",
     "latex": r"\int u\,dv = uv - \int v\,du", "note": "处理乘积的积分"},
    {"title": "泰勒展开", "category": "微积分",
     "latex": r"f(x)=\sum_{n=0}^{\infty}\frac{f^{(n)}(a)}{n!}(x-a)^n",
     "note": "在 $a$ 处展开；$a=0$ 时为麦克劳林级数"},
    {"title": "常用麦克劳林级数", "category": "微积分",
     "latex": r"e^x=\sum_{n=0}^{\infty}\frac{x^n}{n!},\quad"
              r"\sin x=x-\frac{x^3}{3!}+\frac{x^5}{5!}-\cdots,\quad"
              r"\frac{1}{1-x}=\sum_{n=0}^{\infty}x^n\;(|x|<1)", "note": ""},
    {"title": "高斯积分", "category": "微积分",
     "latex": r"\int_{-\infty}^{+\infty} e^{-a x^2}\,dx = \sqrt{\frac{\pi}{a}}\,,\quad a>0", "note": ""},
    {"title": "常用积分 · arctan 型", "category": "微积分",
     "latex": r"\int \frac{dx}{a^2+x^2} = \frac{1}{a}\arctan\frac{x}{a} + C", "note": ""},
    {"title": "洛必达法则", "category": "微积分",
     "latex": r"\lim_{x\to a}\frac{f(x)}{g(x)}=\lim_{x\to a}\frac{f'(x)}{g'(x)}",
     "note": "适用于 $\\frac{0}{0}$、$\\frac{\\infty}{\\infty}$ 型"},
    # —— 代数 ——
    {"title": "二次方程求根公式", "category": "代数",
     "latex": r"x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}", "note": ""},
    {"title": "韦达定理", "category": "代数",
     "latex": r"x_1+x_2=-\frac{b}{a}\,,\quad x_1x_2=\frac{c}{a}", "note": ""},
    {"title": "二项式定理", "category": "代数",
     "latex": r"(a+b)^n=\sum_{k=0}^{n}\binom{n}{k}a^{n-k}b^{k}", "note": ""},
    {"title": "平方差公式", "category": "代数",
     "latex": r"a^2-b^2=(a-b)(a+b)", "note": ""},
    # —— 变换 ——
    {"title": "傅里叶变换（ω 约定）", "category": "变换",
     "latex": r"F(\omega)=\int_{-\infty}^{+\infty} f(t)\,e^{-i\omega t}\,dt",
     "note": "计算台选「傅里叶变换」即按此约定"},
    {"title": "逆傅里叶变换", "category": "变换",
     "latex": r"f(t)=\frac{1}{2\pi}\int_{-\infty}^{+\infty} F(\omega)\,e^{i\omega t}\,d\omega", "note": ""},
    {"title": "拉普拉斯变换", "category": "变换",
     "latex": r"F(s)=\int_{0}^{+\infty} f(t)\,e^{-st}\,dt", "note": "单边拉普拉斯变换"},
    {"title": "常用变换对", "category": "变换",
     "latex": r"\frac{1}{s+a}\ \leftrightarrow\ e^{-at}u(t)\,,\quad"
              r"\frac{\omega_0}{s^2+\omega_0^2}\ \leftrightarrow\ \sin(\omega_0 t)\,u(t)", "note": ""},
    # —— 线性代数 ——
    {"title": "2×2 行列式", "category": "线性代数",
     "latex": r"\det\begin{pmatrix}a&b\\c&d\end{pmatrix}=ad-bc", "note": ""},
    {"title": "2×2 逆矩阵", "category": "线性代数",
     "latex": r"A^{-1}=\frac{1}{\det A}\begin{pmatrix}d&-b\\-c&a\end{pmatrix}", "note": ""},
    {"title": "特征方程", "category": "线性代数",
     "latex": r"\det(A-\lambda I)=0", "note": "解出的 $\\lambda$ 为特征值"},
    {"title": "克拉默法则", "category": "线性代数",
     "latex": r"x_i=\frac{\det A_i}{\det A}", "note": "$A_i$ 为第 $i$ 列被 $b$ 替换后的矩阵"},
    # —— 复数 ——
    {"title": "欧拉公式", "category": "复数",
     "latex": r"e^{i\theta} = \cos\theta + i\sin\theta", "note": "连接指数与三角"},
    {"title": "复数的模与辐角", "category": "复数",
     "latex": r"z=x+iy,\quad |z|=\sqrt{x^2+y^2},\quad \arg z=\arctan\frac{y}{x}", "note": ""},
    {"title": "柯西-黎曼方程", "category": "复数",
     "latex": r"\frac{\partial u}{\partial x}=\frac{\partial v}{\partial y},\quad"
              r"\frac{\partial u}{\partial y}=-\frac{\partial v}{\partial x}",
     "note": "解析函数的充要条件（$f=u+iv$）"},
    {"title": "留数定理", "category": "复数",
     "latex": r"\oint_C f(z)\,dz = 2\pi i \sum_k \operatorname{Res}(f, z_k)",
     "note": "$z_k$ 为 $C$ 内的孤立奇点"},
    {"title": "柯西积分公式", "category": "复数",
     "latex": r"f(a)=\frac{1}{2\pi i}\oint_C \frac{f(z)}{z-a}\,dz", "note": "$a$ 在 $C$ 内部"},
    # —— 物理与工程 ——
    {"title": "牛顿第二定律", "category": "物理与工程",
     "latex": r"\vec{F}=m\vec{a}", "note": ""},
    {"title": "简谐振动方程", "category": "物理与工程",
     "latex": r"\ddot{x}+\omega^2 x=0", "note": "解为 $x=A\\cos(\\omega t+\\varphi)$"},
    {"title": "一维波动方程", "category": "物理与工程",
     "latex": r"\frac{\partial^2 u}{\partial t^2}=v^2\frac{\partial^2 u}{\partial x^2}", "note": ""},
    {"title": "高斯定理（电学）", "category": "物理与工程",
     "latex": r"\oint_S \vec{E}\cdot d\vec{A}=\frac{Q}{\varepsilon_0}", "note": ""},
    {"title": "欧姆定律", "category": "物理与工程",
     "latex": r"U=IR", "note": ""},
    {"title": "KCL 基尔霍夫电流定律", "category": "物理与工程",
     "latex": r"\sum_k i_k = 0", "note": "节点电流代数和为零（流出为正）"},
    {"title": "KVL 基尔霍夫电压定律", "category": "物理与工程",
     "latex": r"\sum_k u_k = 0", "note": "回路电压代数和为零"},
    {"title": "RC 充电过程", "category": "物理与工程",
     "latex": r"v_C(t)=V_S\left(1-e^{-t/RC}\right)", "note": "时间常数 $\\tau=RC$"},
    {"title": "RLC 串联谐振", "category": "物理与工程",
     "latex": r"\omega_0=\frac{1}{\sqrt{LC}}\,,\quad Q=\frac{1}{R}\sqrt{\frac{L}{C}}", "note": ""},
    {"title": "相量阻抗", "category": "物理与工程",
     "latex": r"Z_R=R,\quad Z_L=j\omega L,\quad Z_C=\frac{1}{j\omega C}", "note": "正弦稳态分析"},
    {"title": "戴维南等效定理", "category": "物理与工程",
     "latex": r"v_{th}=v_{oc},\quad R_{th}=\frac{v_{oc}}{i_{sc}}", "note": "开路电压 / 短路电流"},
]
