"""Static configuration shared by the CLI, the API and the MCP server."""

import os

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})

# Vite dev server origins allowed to call the API in --dev mode (BPT_WEB_PORT adds a port,
# e.g. for an isolated end-to-end test instance).
_WEB_PORTS = {5173, int(os.environ.get("BPT_WEB_PORT", "5173"))}
DEV_ORIGINS = frozenset(
    f"http://{host}:{port}" for host in ("localhost", "127.0.0.1") for port in _WEB_PORTS
)

TOKEN_HEADER = "x-bpt-token"  # noqa: S105 - header name, not a secret
TOKEN_COOKIE = "bpt_token"  # noqa: S105 - cookie name, not a secret
ORIGIN_HEADER = "x-bpt-origin"  # "agent" from the MCP server: its changes get snapshots
