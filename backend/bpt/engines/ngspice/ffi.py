"""Minimal ctypes binding to the ngspice shared library (see ``sharedspice.h``).

ngspice keeps global state, so there is at most one :class:`NgSpice` per process.
Simulations run in worker processes (see Instrukcja.md §6.4).
"""

import ctypes
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import numpy.typing as npt

from bpt.engines.ngspice.locate import find_codemodels

_SendChar = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p)
_SendStat = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p)
_ControlledExit = ctypes.CFUNCTYPE(
    ctypes.c_int, ctypes.c_int, ctypes.c_bool, ctypes.c_bool, ctypes.c_int, ctypes.c_void_p
)

# enum simulation_types (sim.h)
SV_TIME, SV_FREQUENCY, SV_VOLTAGE, SV_CURRENT = 1, 2, 3, 4
VF_COMPLEX = 1 << 1


class _Complex(ctypes.Structure):
    _fields_ = [("cx_real", ctypes.c_double), ("cx_imag", ctypes.c_double)]


class _VectorInfo(ctypes.Structure):
    _fields_ = [
        ("v_name", ctypes.c_char_p),
        ("v_type", ctypes.c_int),
        ("v_flags", ctypes.c_short),
        ("v_realdata", ctypes.POINTER(ctypes.c_double)),
        ("v_compdata", ctypes.POINTER(_Complex)),
        ("v_length", ctypes.c_int),
    ]


@dataclass
class Vector:
    name: str
    type: int
    data: npt.NDArray[np.float64] | npt.NDArray[np.complex128]


def _strings(array: "ctypes._Pointer[ctypes.c_char_p]") -> list[str]:
    result: list[str] = []
    i = 0
    while array and array[i]:
        result.append(array[i].decode(errors="replace"))
        i += 1
    return result


class NgSpice:
    """A loaded and initialised ngspice instance."""

    def __init__(self, library: Path, on_status: Callable[[str], None] | None = None) -> None:
        if sys.platform == "win32":
            # Python >= 3.8 does not search the DLL folder for its dependencies.
            self._dll_dir = os.add_dll_directory(str(library.parent))
        self.library = library
        self.exit_requested = False
        self._on_status = on_status
        lib = self._lib = ctypes.CDLL(str(library))
        lib.ngSpice_Init.argtypes = [
            _SendChar, _SendStat, _ControlledExit,
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
        ]  # fmt: skip
        lib.ngSpice_Command.argtypes = [ctypes.c_char_p]
        lib.ngSpice_Circ.argtypes = [ctypes.POINTER(ctypes.c_char_p)]
        lib.ngSpice_CurPlot.restype = ctypes.c_char_p
        lib.ngSpice_AllVecs.argtypes = [ctypes.c_char_p]
        lib.ngSpice_AllVecs.restype = ctypes.POINTER(ctypes.c_char_p)
        lib.ngGet_Vec_Info.argtypes = [ctypes.c_char_p]
        lib.ngGet_Vec_Info.restype = ctypes.POINTER(_VectorInfo)
        self._output: list[str] = []
        # Keep references so the callbacks are not garbage collected.
        self._callbacks = (
            _SendChar(self._on_char),
            _SendStat(self._on_stat),
            _ControlledExit(self._on_exit),
        )
        lib.ngSpice_Init(*self._callbacks, None, None, None, None)
        self.codemodels = find_codemodels(library)
        for model in self.codemodels:
            self.command(f"codemodel {model.as_posix()}")

    def _on_char(self, message: bytes, _ident: int, _user: object) -> int:
        text = message.decode(errors="replace")
        for prefix in ("stdout ", "stderr "):
            text = text.removeprefix(prefix)
        self._output.append(text)
        return 0

    def _on_stat(self, message: bytes, _ident: int, _user: object) -> int:
        if self._on_status is not None:
            self._on_status(message.decode(errors="replace"))
        return 0

    def _on_exit(self, *_args: object) -> int:
        # ngspice asks the host to unload it (fatal error or `quit`); the worker restarts.
        self.exit_requested = True
        return 0

    def command(self, command: str) -> list[str]:
        """Run an ngspice command and return the output lines it produced."""
        start = len(self._output)
        self._lib.ngSpice_Command(command.encode())
        return self._output[start:]

    def load_circuit(self, lines: list[str]) -> list[str]:
        """Load a netlist (title line first, ``.end`` last); returns ngspice output."""
        start = len(self._output)
        encoded: list[bytes | None] = [line.encode() for line in lines]
        encoded.append(None)
        array = (ctypes.c_char_p * len(encoded))(*encoded)
        self._lib.ngSpice_Circ(array)
        return self._output[start:]

    def current_plot(self) -> str:
        plot = self._lib.ngSpice_CurPlot()
        return plot.decode() if plot else ""

    def vector_names(self, plot: str) -> list[str]:
        return _strings(self._lib.ngSpice_AllVecs(plot.encode()))

    def vector(self, plot: str, name: str) -> Vector:
        """Copy of vector ``name`` from ``plot``."""
        info_ptr = self._lib.ngGet_Vec_Info(f"{plot}.{name}".encode())
        if not info_ptr:
            raise KeyError(f"no vector {plot}.{name}")
        info = info_ptr.contents
        n = info.v_length
        data: npt.NDArray[np.float64] | npt.NDArray[np.complex128]
        # Some vectors (e.g. savecurrents of unused terminals) have no data at all.
        if n <= 0 or (not info.v_compdata and not info.v_realdata):
            data = np.zeros(0)
        elif info.v_flags & VF_COMPLEX and info.v_compdata:
            raw = np.ctypeslib.as_array(
                ctypes.cast(info.v_compdata, ctypes.POINTER(ctypes.c_double)), shape=(2 * n,)
            )
            data = raw[0::2] + 1j * raw[1::2]
        else:
            data = np.ctypeslib.as_array(info.v_realdata, shape=(n,)).copy()
        return Vector(name=name, type=info.v_type, data=data)

    def version(self) -> str:
        """Short version string, e.g. ``ngspice-47``."""
        lines = [line.strip() for line in self.command("version -s") if line.strip()]
        for line in lines:
            if "ngspice" in line.lower():
                return line.strip("* ").split(":")[0].strip()
        return lines[0] if lines else "unknown"
