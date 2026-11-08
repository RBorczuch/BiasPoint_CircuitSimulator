"""Finding the ngspice shared library and its XSPICE code models."""

import ctypes.util
import os
import sys
from pathlib import Path

ENV_VAR = "BPT_NGSPICE_LIB"


class NgspiceNotFoundError(RuntimeError):
    """The ngspice shared library could not be located."""


def _default_candidates() -> list[Path]:
    if sys.platform == "win32":
        return [
            Path("C:/Spice64_dll/dll-vs/ngspice.dll"),
            Path("C:/Spice64/bin/ngspice.dll"),
        ]
    return [
        Path("/usr/lib/x86_64-linux-gnu/libngspice.so.0"),
        Path("/usr/lib/libngspice.so.0"),
        Path("/usr/local/lib/libngspice.so"),
        Path("/opt/homebrew/lib/libngspice.dylib"),
    ]


def find_library() -> Path:
    """Return the path of the ngspice shared library.

    The ``BPT_NGSPICE_LIB`` environment variable wins; otherwise common install
    locations and the system library search path are tried.
    """
    explicit = os.environ.get(ENV_VAR)
    if explicit:
        path = Path(explicit)
        if not path.is_file():
            raise NgspiceNotFoundError(f"{ENV_VAR} points to a missing file: {path}")
        return path
    for candidate in _default_candidates():
        if candidate.is_file():
            return candidate
    found = ctypes.util.find_library("ngspice")
    if found:
        return Path(found)
    raise NgspiceNotFoundError(
        f"ngspice shared library not found; set {ENV_VAR} to the path of ngspice.dll / libngspice"
    )


def find_codemodels(library: Path) -> list[Path]:
    """Return XSPICE code model files (``*.cm``) shipped next to ``library``.

    The bundled ``spinit`` hardcodes ``C:/Spice64`` paths, so BiasPoint loads the
    code models itself instead of relying on it.
    """
    roots = [
        library.parent.parent / "lib" / "ngspice",  # Windows archive layout
        library.parent / "ngspice",  # Linux: /usr/lib/<triple>/ngspice
    ]
    for root in roots:
        models = sorted(root.glob("*.cm"))
        if models:
            return models
    return []
