"""An open project: applies commands, keeps undo/redo history and a revision counter."""

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

from bpt.document.commands import AnyCommand, CommandError
from bpt.document.history import describe
from bpt.document.model import Project

Listener = Callable[[int, AnyCommand], None]


@dataclass(frozen=True)
class Step:
    """One undo step as the history panel shows it."""

    label: str
    origin: str  # "user" or "agent"
    time: float  # unix time


class DocumentSession:
    def __init__(self, project: Project, history_limit: int = 500) -> None:
        self.project = project
        self.revision = 0
        self.history_limit = history_limit
        self._undo: list[tuple[AnyCommand, Step]] = []  # inverse commands
        self._redo: list[tuple[AnyCommand, Step]] = []
        self._listeners: list[Listener] = []
        # Requests run in a thread pool and autosave reads from its own thread.
        self.lock = threading.RLock()
        self.before_change: Callable[[], None] | None = None  # e.g. snapshot before agent edits
        self.origin: Callable[[], str] = lambda: "user"  # who sends the current change

    def subscribe(self, listener: Listener) -> Callable[[], None]:
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener)

    def _apply(self, command: AnyCommand) -> AnyCommand:
        if self.before_change is not None:
            self.before_change()
        inverse = command.apply(self.project)
        self.revision += 1
        for listener in list(self._listeners):
            listener(self.revision, command)
        return inverse

    def execute(self, command: AnyCommand) -> int:
        """Apply a command as a new undo step; returns the new revision."""
        with self.lock:
            label = describe(command, self.project, before=True)
            inverse = self._apply(command)
            label = label or describe(command, self.project, before=False) or "Change"
            self._undo.append((inverse, Step(label, self.origin(), time.time())))
            del self._undo[: -self.history_limit]
            self._redo.clear()
            return self.revision

    def undo(self) -> int:
        with self.lock:
            if not self._undo:
                raise CommandError("nothing to undo")
            inverse, step = self._undo.pop()
            self._redo.append((self._apply(inverse), step))
            return self.revision

    def redo(self) -> int:
        with self.lock:
            if not self._redo:
                raise CommandError("nothing to redo")
            command, step = self._redo.pop()
            self._undo.append((self._apply(command), step))
            return self.revision

    def go_to(self, done: int) -> int:
        """Undo or redo until ``done`` steps are applied (a click in the history panel)."""
        with self.lock:
            if not 0 <= done <= len(self._undo) + len(self._redo):
                raise CommandError(f"no history step {done}")
            while len(self._undo) > done:
                self.undo()
            while len(self._undo) < done:
                self.redo()
            return self.revision

    def history(self) -> tuple[list[Step], list[Step]]:
        """(applied steps, oldest first; undone steps that can be redone, next first)."""
        with self.lock:
            return [s for _c, s in self._undo], [s for _c, s in reversed(self._redo)]

    def snapshot(self) -> tuple[int, Project]:
        """A consistent copy of the project with its revision (safe from another thread)."""
        with self.lock:
            return self.revision, self.project.model_copy(deep=True)

    @property
    def can_undo(self) -> bool:
        return bool(self._undo)

    @property
    def can_redo(self) -> bool:
        return bool(self._redo)
