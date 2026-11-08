#!/usr/bin/env bash
# Fail if any dependency uses a license outside the allowlist (Instrukcja.md §9).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

echo "Rust (cargo-deny, engine/deny.toml)"
(cd "$root/engine" && cargo deny --log-level error check licenses)

echo "Python (pip-licenses)"
(cd "$root/backend" && uv run --quiet pip-licenses --from=mixed --partial-match \
  --ignore-packages bpt bpt-native \
  --allow-only "MIT;BSD;Apache;ISC;Mozilla Public License 2.0;MPL-2.0;PSF;Python Software Foundation;Unlicense;CC0" \
  > /dev/null && echo "  ok")

echo "Frontend (pnpm licenses)"
(cd "$root/apps/web" && pnpm licenses list --prod --json | node "$root/scripts/check-npm-licenses.mjs")
