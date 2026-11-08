#!/usr/bin/env bash
# Run all linters and tests. Works on Linux and in Git Bash on Windows.
#   scripts/check.sh          full check (before closing a task)
#   scripts/check.sh --quick  lint + fast tests (pre-commit hook)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
quick=false
[[ "${1:-}" == "--quick" ]] && quick=true

step() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }

step "Rust: fmt, clippy, tests"
cd "$root/engine"
cargo fmt --all --check
cargo clippy --workspace --all-targets --quiet -- -D warnings
$quick || cargo test --workspace --exclude bpt-py --quiet

step "Python: ruff, mypy, pytest"
cd "$root/backend"
uv run --quiet ruff format --check .
uv run --quiet ruff check .
uv run --quiet mypy
if $quick; then
  uv run --quiet pytest -q -m "not ngspice"
else
  uv run --quiet pytest -q
fi

step "Frontend: biome, tests, build"
cd "$root/apps/web"
pnpm --silent lint
pnpm --silent test
$quick || pnpm --silent build

if ! $quick; then
  step "Licenses"
  "$root/scripts/licenses.sh"
fi

printf '\n\033[1;32mAll checks passed.\033[0m\n'
