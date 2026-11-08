"""File format migrations.

Each migration upgrades raw JSON (``project.json`` contents + sheet dicts) from version N to
N+1. Register it in ``MIGRATIONS[N]`` and bump ``SCHEMA_VERSION`` in :mod:`bpt.document.model`.
"""

from collections.abc import Callable
from typing import Any

from bpt.document.model import SCHEMA_VERSION

Json = dict[str, Any]
Migration = Callable[[Json, list[Json]], tuple[Json, list[Json]]]

MIGRATIONS: dict[int, Migration] = {}


class UnsupportedVersionError(ValueError):
    """The file was written by a newer BiasPoint."""


def migrate(meta: Json, sheets: list[Json]) -> tuple[Json, list[Json]]:
    version = int(meta.get("schema_version", 1))
    if version > SCHEMA_VERSION:
        raise UnsupportedVersionError(
            f"project schema {version} is newer than supported {SCHEMA_VERSION}"
        )
    while version < SCHEMA_VERSION:
        meta, sheets = MIGRATIONS[version](meta, sheets)
        version += 1
        meta["schema_version"] = version
    return meta, sheets


class GraphVersionError(UnsupportedVersionError):
    """The graph was written by a newer BiasPoint."""


def migrate_graph(data: Json) -> Json:
    """A graph file to the current version (without its ``schema_version``).

    1 -> 2: nodes get ``version`` 1 (their types' parameters as they were), the graph empty
    groups, notes, reroutes and subgraphs (the model's defaults)."""
    from bpt.document.model import GRAPH_VERSION

    data = dict(data)
    version = int(data.pop("schema_version", 1))
    if version > GRAPH_VERSION:
        raise GraphVersionError(f"graph {data.get('name', '')!r}: version {version} is newer "
                                f"than supported {GRAPH_VERSION}")  # fmt: skip
    if version < 2:
        data["nodes"] = [{"version": 1, **node} for node in data.get("nodes", [])]
        for key in ("groups", "notes", "reroutes"):
            data.setdefault(key, [])
        data.setdefault("subgraphs", {})
    return data
