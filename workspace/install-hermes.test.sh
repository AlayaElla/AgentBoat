#!/usr/bin/env bash
set -euo pipefail
source_dir="$(cd "$(dirname "$0")" && pwd)"
temp="$(mktemp -d)"
trap 'rm -rf "$temp"' EXIT
export HOME="$temp/home with spaces" HERMES_HOME="$temp/hermes home" ORCA_USER_DATA_PATH="$temp/orca"
export HERMES_INSTALL_DIR="$HERMES_HOME/hermes-agent" PATH="$temp/bin:$PATH"
export PYTHON="${PYTHON:-python3}"
workspace="$temp/repo/workspace"
mkdir -p "$temp/bin" "$HOME/.local/bin" "$HERMES_INSTALL_DIR/scripts" "$workspace/skill" "$temp/repo/coordinator/scripts"
cp "$source_dir"/{configure-hermes.py,install-hermes.sh} "$workspace/"
cp -R "$source_dir/skill/agentboat-hermes" "$workspace/skill/"
printf '#!/bin/sh\necho Darwin\n' > "$temp/bin/uname"
cat > "$temp/bin/curl" <<'SH'
#!/bin/sh
[ "$*" = '-fsSL https://hermes-agent.nousresearch.com/install.sh' ] || exit 1
echo 'test "$*" = "--non-interactive" && echo install >> "$HOME/actions"'
SH
cat > "$HOME/.local/bin/hermes" <<'SH'
#!/bin/sh
[ "$*" = 'gateway install --no-start-now' ] && echo launchd >> "$HOME/actions"
SH
cat > "$HERMES_INSTALL_DIR/scripts/hermes-python" <<'SH'
#!/bin/sh
exec "$PYTHON" "$@"
SH
chmod +x "$temp/bin/"* "$HOME/.local/bin/hermes" "$HERMES_INSTALL_DIR/scripts/hermes-python"
cat > "$HERMES_INSTALL_DIR/hermes_yaml.py" <<'PY'
import json
safe_load = json.loads
def safe_dump(value, **options):
    return json.dumps(value)
PY
cat > "$temp/repo/coordinator/scripts/client.mjs" <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
assert.deepEqual(process.argv.slice(2), ['--workspace-request', 'workspace.connections']);
const data = JSON.parse(readFileSync(0, 'utf8'));
if (data.operation === 'save') {
  assert.equal(data.name, 'Hermes');
  assert.equal(data.type, 'a2a');
  assert.equal(data.port, 9901);
  assert.equal(data.url, 'http://127.0.0.1:9900');
  assert.ok(data.inboundToken.length >= 32 && data.outboundToken.length >= 32);
  assert.notEqual(data.inboundToken, data.outboundToken);
} else assert.deepEqual(data, {operation:'read'});
console.log(JSON.stringify({result:{result:[]}}));
JS
echo '{"existing":"keep"}' > "$HERMES_HOME/config.yaml"
bash "$workspace/install-hermes.sh" > "$temp/output"
cp "$HERMES_HOME/config.yaml" "$temp/first"
bash "$workspace/install-hermes.sh" --configure-only >> "$temp/output"
cmp "$temp/first" "$HERMES_HOME/config.yaml"
cmp "$workspace/skill/agentboat-hermes/SKILL.md" "$HERMES_HOME/skills/agentboat-hermes/SKILL.md"
test -d "$HERMES_HOME/daily"
test "$(cat "$HOME/actions")" = "$(printf 'install\nlaunchd\nlaunchd')"
"$PYTHON" - "$temp/output" <<'PY'
import json, os, sys
from pathlib import Path
home = Path(os.environ['HERMES_HOME'])
config = json.loads((home / 'config.yaml').read_text())
env = dict(line.split('=', 1) for line in (home / '.env').read_text().splitlines() if '=' in line)
log = Path(sys.argv[1]).read_bytes()
assert config['existing'] == 'keep' and config['approvals']['mode'] == 'smart'
assert env['A2A_HOST'] == '127.0.0.1' and env['A2A_PORT'] == '9900'
assert all(token.encode() not in log for token in (env['A2A_BEARER_TOKEN'], config['a2a_agents']['orca-main']['auth']['token']))
assert list(home.glob('config.yaml.before-hermes-*'))
if os.name == 'posix':
    assert all(f.stat().st_mode & 0o077 == 0 for f in [home / 'config.yaml', home / '.env', *home.glob('*.before-hermes-*')])
PY
echo 'Hermes installer, configuration, rerun and login service checks passed (fixtures).'
