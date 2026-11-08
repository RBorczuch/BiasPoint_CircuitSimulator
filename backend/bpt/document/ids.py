"""Object identifiers: UUIDv7 (time-ordered, so sorting by id keeps creation order).

Ids also name folders (projects, snapshots, recovery copies, runs). They arrive from URLs and
agent tools, so ``safe_id`` checks one before it becomes part of a path: ``..`` or ``a/b``
would otherwise reach (and delete) folders outside the store.
"""

import os
import re
import threading
import time
import uuid

_lock = threading.Lock()
_last_ms = 0
_counter = 0


def new_id() -> uuid.UUID:
    """Return a new RFC 9562 UUID version 7, monotonic within this process.

    Ids created in the same millisecond use ``rand_a`` as a counter (RFC 9562 method 1),
    so sorting by id always reproduces creation order.
    """
    global _last_ms, _counter
    with _lock:
        unix_ms = time.time_ns() // 1_000_000
        if unix_ms <= _last_ms:
            unix_ms = _last_ms
            _counter += 1
            if _counter > 0xFFF:  # counter overflow: borrow the next millisecond
                unix_ms += 1
                _counter = 0
        else:
            _counter = 0
        _last_ms = unix_ms
        counter = _counter
    rand_b = int.from_bytes(os.urandom(8), "big") & ((1 << 62) - 1)
    value = (unix_ms & ((1 << 48) - 1)) << 80
    value |= 0x7 << 76  # version
    value |= counter << 64  # 12 bits rand_a = counter
    value |= 0b10 << 62  # variant
    value |= rand_b
    return uuid.UUID(int=value)


_SAFE = re.compile(r"[0-9A-Za-z][0-9A-Za-z_-]{0,63}")


class UnsafeIdError(KeyError, ValueError):
    """Not a valid id; a ``KeyError`` (not found) and a ``ValueError`` for existing handlers."""

    def __str__(self) -> str:
        return str(self.args[0]) if self.args else "invalid id"


def safe_id(value: str, what: str = "id") -> str:
    """``value`` if it can be a single folder name made by ``new_id``; raises otherwise."""
    if not _SAFE.fullmatch(value):
        raise UnsafeIdError(f"invalid {what}: {value!r}")
    return value
