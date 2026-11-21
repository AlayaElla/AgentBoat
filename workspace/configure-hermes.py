"""Configure an installed Hermes home; credentials stay in local runtime files."""
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
from datetime import datetime
import hermes_yaml as yaml

HOST = '127.0.0.1'
HERMES_PORT, ORCA_PORT = 9900, 9901
HERMES_URL, ORCA_URL = f'http://{HOST}:{HERMES_PORT}', f'http://{HOST}:{ORCA_PORT}'


def settings(config, home, skill, token, attach=False):
    gateway = config.get('gateway') or {}
    platforms = {**(gateway.get('platforms') or {}), 'a2a': {'enabled': True, 'extra': {'port': HERMES_PORT}}}
    config['gateway'] = {**gateway, 'platforms': platforms}
    peer = {'url': ORCA_URL, 'auth': {'type': 'bearer', 'token': token}, 'timeout': 600, 'capabilities': ['daily']}
    config['a2a_agents'] = {**(config.get('a2a_agents') or {}), 'orca-main': peer}
    toolsets = dict(config.get('platform_toolsets') or {})
    defaults = ['web', 'browser', 'terminal', 'file', 'skills', 'cronjob', 'memory', 'computer_use', 'a2a']
    if attach:
        selected = toolsets.get('a2a', defaults)
        if not isinstance(selected, list):
            raise SystemExit('Invalid platform_toolsets.a2a; expected a list')
        toolsets['a2a'] = selected if 'a2a' in selected else [*selected, 'a2a']
    else:
        config['agent'] = {**(config.get('agent') or {}), 'system_prompt': skill}
        config['terminal'] = {**(config.get('terminal') or {}), 'cwd': str(home / 'daily')}
        config['skills'] = {**(config.get('skills') or {}), 'external_dirs': []}
        config['approvals'] = {**(config.get('approvals') or {}), 'mode': 'smart', 'cron_mode': 'deny', 'single_query_mode': 'deny', 'unattended_mode': 'deny'}
        for name in ('cli', 'a2a', 'cron'):
            toolsets[name] = defaults.copy()
    config['platform_toolsets'] = toolsets
    return config


if sys.argv[1:] == ['--self-test']:
    result = settings({'existing': {'keep': True}}, Path('daily-home'), 'skill', 'test-token')
    assert result['existing'] == {'keep': True}
    assert result['approvals']['mode'] == 'smart'
    assert all(result['approvals'][key] == 'deny' for key in ('cron_mode', 'single_query_mode', 'unattended_mode'))
    assert result['skills']['external_dirs'] == []
    assert all('a2a' in result['platform_toolsets'][key] for key in ('cli', 'a2a', 'cron'))
    assert settings({'gateway': None, 'skills': None, 'a2a_agents': None}, Path('daily-home'), 'skill', 'test-token')['gateway']['platforms']['a2a']['enabled']
    print('Hermes configuration self-check passed')
    sys.exit(0)

home = Path(os.environ.get('HERMES_HOME') or (Path(os.environ['LOCALAPPDATA']) / 'hermes' if os.name == 'nt' else Path.home() / '.hermes'))
root = Path(__file__).resolve().parent
attach = sys.argv[1:3] == ['--attach', '--profile'] and len(sys.argv) == 4
if attach:
    name = sys.argv[3]
    profiles = home / 'profiles'
    home = profiles / name
    if not name or name in ('.', '..') or Path(name).name != name or profiles.is_symlink() or home.is_symlink() or not home.is_dir():
        raise SystemExit('Named Hermes profile directory not found or not local to profiles/')
elif sys.argv[1:]:
    raise SystemExit('Expected --attach --profile NAME')
config_path, env_path = home / 'config.yaml', home / '.env'
target = home / 'skills/agentboat-hermes'
if attach:
    if any(path.is_symlink() for path in (config_path, env_path, target.parent, target)):
        raise SystemExit('Linked profile files or skills directory; inspect this profile before attaching')
    if not config_path.is_file():
        raise SystemExit('Named profile has no config.yaml')
try:
    config = yaml.safe_load(config_path.read_text(encoding='utf-8-sig')) or {}
except yaml.YAMLError:
    raise SystemExit('Invalid Hermes config.yaml; inspect the file locally') from None
env_bytes = env_path.read_bytes() if env_path.exists() else b''
env = env_bytes.decode('utf-8-sig')
if attach:
    gateway = config.get('gateway') or {}
    if any('a2a' in section for section in (config, gateway, config.get('platforms') or {}, gateway.get('platforms') or {})):
        raise SystemExit('Profile already has an A2A platform; nothing changed')
    if config.get('a2a_agents') or re.search(r'(?m)^[ \t]*(?:export[ \t]+)?A2A_\w+[ \t]*=', env):
        raise SystemExit('Profile already has A2A peers or environment settings; nothing changed')
    if target.exists():
        raise SystemExit('Profile already has the agentboat-hermes skill; nothing changed')
    for port in (HERMES_PORT, ORCA_PORT):
        with socket.socket() as probe:
            try:
                probe.bind((HOST, port))
            except OSError:
                raise SystemExit(f'Loopback port {port} unavailable; nothing changed') from None
elif config.get('a2a_agents') and 'orca-main' not in config['a2a_agents']:
    raise SystemExit('Existing Hermes peers found; inspect this home before configuring Hermes')
elif any((value or {}).get('enabled') for name, value in ((config.get('gateway') or {}).get('platforms') or {}).items() if name != 'a2a'):
    raise SystemExit('Existing user channels found; inspect this home before configuring Hermes')
values = dict(line.split('=', 1) for line in env.splitlines() if '=' in line and not line.lstrip().startswith('#'))
outbound = values.get('A2A_BEARER_TOKEN') or secrets.token_urlsafe(48)
inbound = (config.get('a2a_agents') or {}).get('orca-main', {}).get('auth', {}).get('token') or secrets.token_urlsafe(48)
skill = (root / 'skill/agentboat-hermes/SKILL.md').read_text(encoding='utf-8')
config = settings(config, home, skill, inbound, attach)
overrides = {'A2A_HOST': HOST, 'A2A_PORT': str(HERMES_PORT), 'A2A_AGENT_NAME': 'Hermes', 'A2A_BEARER_TOKEN': outbound, 'A2A_TRUSTED_PEERS': f'ip:{HOST}', 'A2A_ALLOW_ALL_USERS': 'false'}
if not attach:
    env = '\n'.join(line for line in env.splitlines() if line.split('=', 1)[0] not in overrides) + '\n'
    env_bytes = env.encode()
elif env and not env.endswith(('\r', '\n')):
    env_bytes += b'\n'
env_bytes += ''.join(f'{k}={v}\n' for k, v in overrides.items()).encode()
client = root.parent / 'coordinator/scripts/client.mjs'
def request(data):
    proc = subprocess.run(['node', str(client), '--workspace-request', 'workspace.connections'], input=json.dumps(data), capture_output=True, text=True, encoding='utf-8', timeout=90)
    if proc.returncode:
        raise SystemExit('Orca Hermes settings request failed; local credentials were not printed, inspect plugin logs')
    return json.loads(proc.stdout)['result']['result']
connections = request({'operation': 'read'})
matched = [entry for entry in connections if entry['name'] == 'Hermes']
if attach and matched:
    raise SystemExit('AgentBoat already has a connection named Hermes; nothing changed')
if len(matched) > 1 or matched and matched[0]['type'] != 'a2a':
    raise SystemExit('Hermes name must identify exactly one A2A connection')
current = request({'operation': 'read', 'connectionId': matched[0]['id']})['a2a'] if matched else None
if current and current['entries'] and (current['port'] != ORCA_PORT or current['url'] != HERMES_URL):
    raise SystemExit('Existing Hermes messages use other endpoints; inspect before changing')
save = {'operation': 'save', **({'connectionId': matched[0]['id']} if matched else {'type': 'a2a'}), 'name': 'Hermes', 'revision': current['revision'] if current else 0, 'enabled': True, 'port': ORCA_PORT, 'url': HERMES_URL, 'inboundToken': inbound, 'outboundToken': outbound}
config_text = yaml.safe_dump(config, allow_unicode=True, sort_keys=False)
stamp = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
for file in (config_path, env_path):
    if file.exists():
        backup = file.with_name(file.name + '.before-hermes-' + stamp)
        with backup.open('xb') as stream:
            if os.name == 'posix':
                os.fchmod(stream.fileno(), 0o600)
            stream.write(file.read_bytes())

if not attach:
    request(save)
    if os.name == 'posix':
        for file in (config_path, env_path):
            if file.exists():
                file.chmod(0o600)
    config_path.write_text(config_text, encoding='utf-8')
    env_path.write_text(env_bytes.decode(), encoding='utf-8')
    (home / 'daily').mkdir(exist_ok=True)
target.mkdir(parents=True, exist_ok=not attach)
shutil.copy2(root / 'skill/agentboat-hermes/SKILL.md', target / 'SKILL.md')
if attach:
    # Replace both files from private staging so existing hard links keep their original contents.
    with TemporaryDirectory(dir=home) as directory:
        staging = Path(directory)
        (staging / config_path.name).write_bytes(config_text.encode())
        (staging / env_path.name).write_bytes(env_bytes)
        for file in (config_path, env_path):
            (staging / file.name).replace(file)
    try:
        saved = request({**save, 'includeApprovalMode': False})['a2a']
        if saved['error'] or saved['listening'] != ORCA_URL:
            raise ValueError('listener unavailable')
    except (SystemExit, OSError, subprocess.TimeoutExpired, KeyError, ValueError, TypeError):
        raise SystemExit(f'Profile files written; AgentBoat listener unconfirmed. Inspect the Hermes connection and use the {stamp} backups to roll back before retrying.') from None
else:
    print(json.dumps({'configured': True, 'hermesPort': HERMES_PORT, 'orcaPort': ORCA_PORT, 'host': HOST, 'approvals': 'smart; unattended/cron/single-query deny', 'credentialsPrinted': False}))
