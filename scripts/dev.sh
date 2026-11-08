#!/usr/bin/env bash
# Start the BiasPoint backend (auto-reload) and the Vite dev server.
# Usage: ./scripts/dev.sh    -> open http://127.0.0.1:5173
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

(cd "$root/backend" && exec uv run bpt serve --dev --reload) &
backend=$!
trap 'kill $backend 2>/dev/null || true' EXIT

cd "$root/apps/web" && pnpm dev
