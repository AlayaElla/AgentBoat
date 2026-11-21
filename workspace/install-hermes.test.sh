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
import json, os, socket
YAMLError = ValueError
safe_load = json.loads
def safe_dump(value, **options):
    return json.dumps(value)
def probe(self, address):
    assert address[0] == '127.0.0.1' and address[1] in (9900, 9901)
    if str(address[1]) == os.getenv('BUSY_PORT'):
        raise OSError('fixture port busy')
socket.socket.bind = probe
PY
cat > "$temp/repo/coordinator/scripts/client.mjs" <<'JS'
import assert from 'node:assert/strict';
import {appendFileSync, readFileSync} from 'node:fs';
assert.deepEqual(process.argv.slice(2), ['--workspace-request', 'workspace.connections']);
const data = JSON.parse(readFileSync(0, 'utf8'));
let result = process.env.EXISTING_CONNECTION ? [{name:'Hermes', type:'a2a'}] : [];
if (data.operation === 'save') {
  assert.equal(data.name, 'Hermes');
  assert.equal(data.type, 'a2a');
  assert.equal(data.port, 9901);
  assert.equal(data.url, 'http://127.0.0.1:9900');
  assert.ok(data.inboundToken.length >= 32 && data.outboundToken.length >= 32);
  assert.notEqual(data.inboundToken, data.outboundToken);
  if (process.env.ATTACH_TEST) {
    const profile = process.env.HERMES_HOME + '/profiles/星月/';
    const env = readFileSync(profile + '.env', 'utf8');
    const config = JSON.parse(readFileSync(profile + 'config.yaml', 'utf8'));
    assert.ok(env.includes('A2A_BEARER_TOKEN=' + data.outboundToken + '\n'));
    assert.ok(config.a2a_agents['orca-main'].auth.token === data.inboundToken);
    assert.equal(data.includeApprovalMode, false);
    appendFileSync(process.env.ATTACH_TEST, 'save\n');
    result = {a2a:{error:'', listening:'http://127.0.0.1:9901'}};
  }
} else assert.deepEqual(data, {operation:'read'});
console.log(JSON.stringify({result:{result}}));
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

profile="$HERMES_HOME/profiles/星月"
export ATTACH_TEST="$temp/registration"
mkdir -p "$HERMES_INSTALL_DIR/.venv/bin" "$profile/skills/local"
cp "$HERMES_INSTALL_DIR/scripts/hermes-python" "$HERMES_INSTALL_DIR/.venv/bin/python"
unset HERMES_PYTHON
for name in cat 星梦; do
  mkdir -p "$HERMES_HOME/profiles/$name"
  echo '{"platforms":{"qqbot":{"enabled":true}}}' > "$HERMES_HOME/profiles/$name/config.yaml"
  echo fixture > "$HERMES_HOME/profiles/$name/.env"
done
cat > "$profile/config.yaml" <<'JSON'
{"agent":{"system_prompt":"保留星月"},"gateway":{"platforms":{"qqbot":{"enabled":true}}},"skills":{"external_dirs":["../custom"]},"approvals":{"mode":"manual"},"platform_toolsets":{"a2a":["file"],"cli":["memory"],"cron":[]},"other":42}
JSON
printf '# QQ\r\nQQ_VALUE=fixture' > "$profile/.env"
echo fixture > "$profile/auth.json"
echo fixture > "$profile/skills/local/SKILL.md"
attach() { bash "$workspace/install-hermes.sh" --attach --profile "${1:-星月}"; }
refuses() {
  local expected="$1" name="${2:-星月}"
  local before
  before="$(mktemp -d "$temp/check.XXXXXX")"
  cp -R "$HERMES_HOME/." "$before/"
  if attach "$name" > "$temp/refusal" 2>&1; then echo "Expected refusal: $expected" >&2; exit 1; fi
  grep -Fq "$expected" "$temp/refusal"
  diff -qr "$before" "$HERMES_HOME"
}
cp "$profile/config.yaml" "$temp/original"
refuses 'profile directory' missing
refuses 'profile directory' '../星月'
for config in '{"gateway":{"platforms":{"a2a":{"enabled":false}}}}' '{"platforms":{"a2a":{}}}'; do
  echo "$config" > "$profile/config.yaml"
  refuses 'A2A platform'
done
echo '{"a2a_agents":{"other":{},"orca-main":{}}}' > "$profile/config.yaml"
refuses 'A2A peers'
cp "$temp/original" "$profile/config.yaml"
cp "$profile/.env" "$temp/original-env"
printf '\nexport A2A_PORT=9000\n' >> "$profile/.env"
refuses 'A2A peers or environment settings'
cp "$temp/original-env" "$profile/.env"
mkdir "$profile/skills/agentboat-hermes"
refuses 'already has the agentboat-hermes skill'
rmdir "$profile/skills/agentboat-hermes"
BUSY_PORT=9900 refuses 'port 9900'
BUSY_PORT=9901 refuses 'port 9901'
EXISTING_CONNECTION=1 refuses 'connection named Hermes'
test ! -e "$ATTACH_TEST"
cp -R "$HERMES_HOME" "$temp/before"
attach > "$temp/attached" 2>&1
grep -Fqx '请由维护网关的人在合适的时间重启现有网关' "$temp/attached"
refuses 'A2A platform'
test "$(cat "$ATTACH_TEST")" = save
test "$(cat "$HOME/actions")" = "$(printf 'install\nlaunchd\nlaunchd')"
"$PYTHON" - "$temp/before" "$temp/attached" <<'PY'
import json, os, sys
from pathlib import Path
home, before = Path(os.environ['HERMES_HOME']), Path(sys.argv[1])
profile = home / 'profiles/星月'
original = before / profile.relative_to(home)
def backups(name):
    saved, = profile.glob(name + '.before-hermes-*')
    assert saved.read_bytes() == (original / name).read_bytes()
    return saved
added = [backups('config.yaml'), backups('.env'), profile/'skills/agentboat-hermes', profile/'skills/agentboat-hermes/SKILL.md']
allowed = {f.relative_to(home) for f in added}
paths = lambda root: {p.relative_to(root) for p in root.rglob('*')}
assert paths(home) == paths(before) | allowed
changed = {profile/'config.yaml', profile/'.env'}
for p in before.rglob('*'):
    copy = home / p.relative_to(before)
    if p.is_file() and copy not in changed:
        assert copy.read_bytes() == p.read_bytes(), p
if os.name == 'posix':
    assert all(f.stat().st_mode & 0o077 == 0 for f in [*added[:2], *changed])
c = json.loads((profile/'config.yaml').read_bytes())
assert c['gateway']['platforms'].pop('a2a') == {'enabled': True, 'extra': {'port': 9900}}
peer = c.pop('a2a_agents')['orca-main']
token = peer['auth'].pop('token')
assert peer == {'url':'http://127.0.0.1:9901','auth':{'type':'bearer'},'timeout':600,'capabilities':['daily']}
assert c['platform_toolsets']['a2a'].pop() == 'a2a'
assert c == json.loads((original/'config.yaml').read_bytes())
env = (profile/'.env').read_bytes()
prefix = (original/'.env').read_bytes() + b'\n'
assert env.startswith(prefix)
values = dict(line.split('=', 1) for line in env[len(prefix):].decode().splitlines())
other = values.pop('A2A_BEARER_TOKEN')
assert values == {'A2A_HOST':'127.0.0.1','A2A_PORT':'9900','A2A_AGENT_NAME':'Hermes','A2A_TRUSTED_PEERS':'ip:127.0.0.1','A2A_ALLOW_ALL_USERS':'false'}
assert all(t.encode() not in Path(sys.argv[2]).read_bytes() for t in (token, other))
PY
cmp "$workspace/skill/agentboat-hermes/SKILL.md" "$profile/skills/agentboat-hermes/SKILL.md"
echo 'Hermes profile attachment, isolation, backups, registration, conflict guards and rerun checks passed (fixtures).'
