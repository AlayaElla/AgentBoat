#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Run this installer on macOS.' >&2
  exit 1
fi
case "$#:${1:-}" in
  0:) curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --non-interactive ;;
  1:--configure-only) ;;
  *) echo 'Usage: bash install-hermes.sh [--configure-only]' >&2; exit 2 ;;
esac

export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
install_root="${HERMES_INSTALL_DIR:-$HERMES_HOME/hermes-agent}"
configure="$(cd "$(dirname "$0")" && pwd)/configure-hermes.py"
bootstrap='import runpy, sys; sys.path.insert(0, sys.argv.pop(1)); runpy.run_path(sys.argv[1], run_name="__main__")'
python="$install_root/scripts/hermes-python"
"$python" -I -c "$bootstrap" "$install_root" "$configure" --self-test
"$python" -I -c "$bootstrap" "$install_root" "$configure"
"$HOME/.local/bin/hermes" gateway install --no-start-now
echo 'Ready for login. Run ~/.local/bin/hermes model, then ~/.local/bin/hermes gateway start.'
