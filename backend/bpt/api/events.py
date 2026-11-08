"""Event bus: thread-safe publish, asyncio queues per WebSocket client."""

import asyncio
from typing import Any

Event = dict[str, Any]
_QUEUE_LIMIT = 1000


class EventBus:
    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queues: set[asyncio.Queue[Event]] = set()

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue[Event]:
        queue: asyncio.Queue[Event] = asyncio.Queue(maxsize=_QUEUE_LIMIT)
        self._queues.add(queue)
        return queue

    @property
    def clients(self) -> int:
        """Number of connected WebSocket clients (GUI windows)."""
        return len(self._queues)

    def unsubscribe(self, queue: asyncio.Queue[Event]) -> None:
        self._queues.discard(queue)

    def publish(self, event: Event) -> None:
        """Callable from any thread; drops events for clients that stopped reading."""
        if self._loop is None or self._loop.is_closed():
            return
        self._loop.call_soon_threadsafe(self._fan_out, event)

    def _fan_out(self, event: Event) -> None:
        for queue in list(self._queues):
            if queue.full():
                continue
            queue.put_nowait(event)
