"""A small S-expression reader (KiCad file formats: ``(name value (child ...) ...)``).

Lists become Python lists, quoted strings become ``str`` (unescaped), other atoms stay ``str``
too; numbers are converted where they are used. Written from the published file format.
"""

from collections.abc import Iterator

SExpr = list["SExpr"] | str


class SExprError(ValueError):
    pass


def _tokens(text: str) -> Iterator[tuple[str, bool]]:
    """(token, quoted) pairs: "(", ")", atoms and strings."""
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in " \t\r\n":
            i += 1
        elif c in "()":
            yield c, False
            i += 1
        elif c == '"':
            out: list[str] = []
            i += 1
            while i < n and text[i] != '"':
                if text[i] == "\\" and i + 1 < n:
                    i += 1
                    out.append({"n": "\n", "t": "\t"}.get(text[i], text[i]))
                else:
                    out.append(text[i])
                i += 1
            if i >= n:
                raise SExprError("unterminated string")
            yield "".join(out), True
            i += 1
        else:
            start = i
            while i < n and text[i] not in ' \t\r\n()"':
                i += 1
            yield text[start:i], False


def parse(text: str) -> SExpr:
    """The first expression in ``text``."""
    stack: list[list[SExpr]] = []
    for token, quoted in _tokens(text):
        bracket = None if quoted else token
        if bracket == "(":
            stack.append([])
        elif bracket == ")":
            if not stack:
                raise SExprError("unexpected ')'")
            done = stack.pop()
            if not stack:
                return done
            stack[-1].append(done)
        elif stack:
            stack[-1].append(token)
        else:
            return token
    raise SExprError("unexpected end of file")


def head(expr: SExpr) -> str:
    return expr[0] if isinstance(expr, list) and expr and isinstance(expr[0], str) else ""


def children(expr: SExpr, name: str) -> list[list[SExpr]]:
    """Direct child lists called ``name``."""
    if not isinstance(expr, list):
        return []
    return [c for c in expr if isinstance(c, list) and head(c) == name]


def child(expr: SExpr, name: str) -> list[SExpr] | None:
    found = children(expr, name)
    return found[0] if found else None


def value(expr: SExpr, name: str, index: int = 1, default: str = "") -> str:
    """Atom ``index`` of child ``name``: ``value((at 1 2), "at", 2) == "2"``."""
    found = child(expr, name)
    if found is None or len(found) <= index or not isinstance(found[index], str):
        return default
    return found[index]  # type: ignore[return-value]
