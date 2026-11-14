"""Configure an installed Hermes home; credentials stay in local runtime files."""
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
from datetime import datetime
import hermes_yaml as yaml


def settings(config, home, skill, token):
    for key in ('agent', 'terminal', 'skills', 'approvals', 'gateway', 'platform_toolsets', 'a2a_agents'):
        if config.get(key) is None:
            config[key] = {}
    if config['gateway'].get('platforms') is None:
        config['gateway']['platforms'] = {}
    config.setdefault('agent', {})['system_prompt'] = skill
    config.setdefault('terminal', {})['cwd'] = str(home / 'daily')
    config.setdefault('skills', {})['external_dirs'] = []
    config['approvals'] = {**config.get('approvals', {}), 'mode': 'manual', 'cron_mode': 'deny', 'single_query_mode': 'deny', 'unattended_mode': 'deny'}
    config.setdefault('gateway', {}).setdefault('platforms', {})['a2a'] = {'enabled': True, 'extra': {'port': 9900}}
    for name in ('cli', 'a2a', 'cron'):
        config.setdefault('platform_toolsets', {})[name] = ['web', 'browser', 'terminal', 'file', 'skills', 'cronjob', 'memory', 'computer_use', 'a2a']
    config.setdefault('a2a_agents', {})['orca-main'] = {'url': 'http://127.0.0.1:9901', 'auth': {'type': 'bearer', 'token': token}, 'timeout': 600, 'capabilities': ['butler']}
    return config


if '--self-test' in sys.argv:
    result = settings({'existing': {'keep': True}}, Path('daily-home'), 'skill', 'test-token')
    assert result['existing'] == {'keep': True}
    assert result['approvals']['mode'] == 'manual'
    assert all(result['approvals'][key] == 'deny' for key in ('cron_mode', 'single_query_mode', 'unattended_mode'))
    assert result['skills']['external_dirs'] == []
    assert all('a2a' in result['platform_toolsets'][key] for key in ('cli', 'a2a', 'cron'))
    assert settings({'gateway': None, 'skills': None, 'a2a_agents': None}, Path('daily-home'), 'skill', 'test-token')['gateway']['platforms']['a2a']['enabled']
    print('Hermes configuration self-check passed')
    sys.exit(0)

home = Path(os.environ.get('HERMES_HOME', str(Path(os.environ['LOCALAPPDATA']) / 'hermes')))
root = Path(__file__).resolve().parent
config_path, env_path = home / 'config.yaml', home / '.env'
config = yaml.safe_load(config_path.read_text(encoding='utf-8-sig')) or {}
# Refuse to reconfigure an existing unrelated agent or channel.
if config.get('a2a_agents') and 'orca-main' not in config['a2a_agents']:
    raise SystemExit('Existing Hermes peers found; inspect this home before configuring the butler')
if any((value or {}).get('enabled') for name, value in ((config.get('gateway') or {}).get('platforms') or {}).items() if name != 'a2a'):
    raise SystemExit('Existing user channels found; inspect this home before configuring the butler')
stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
for file in (config_path, env_path):
    if file.exists():
        shutil.copy2(file, file.with_name(file.name + '.before-butler-' + stamp))
env = env_path.read_text(encoding='utf-8-sig') if env_path.exists() else ''
values = dict(line.split('=', 1) for line in env.splitlines() if '=' in line and not line.lstrip().startswith('#'))
outbound = values.get('A2A_BEARER_TOKEN') or secrets.token_urlsafe(48)
inbound = (config.get('a2a_agents') or {}).get('orca-main', {}).get('auth', {}).get('token') or secrets.token_urlsafe(48)
skill = (root / 'skill/agentboat-butler/SKILL.md').read_text(encoding='utf-8')
config = settings(config, home, skill, inbound)
overrides = {'A2A_HOST': '127.0.0.1', 'A2A_PORT': '9900', 'A2A_AGENT_NAME': 'Hermes Butler', 'A2A_BEARER_TOKEN': outbound, 'A2A_TRUSTED_PEERS': 'ip:127.0.0.1', 'A2A_ALLOW_ALL_USERS': 'false'}
env = '\n'.join(line for line in env.splitlines() if line.split('=', 1)[0] not in overrides) + '\n'
env += ''.join(f'{k}={v}\n' for k, v in overrides.items())
exe = os.environ.get('ORCA_CLI_COMMAND') or shutil.which('orca')
if not exe:
    raise SystemExit('Run in an Orca terminal so ORCA_CLI_COMMAND identifies the host CLI')
plugin = str(root.parent / 'coordinator/plugin')
def request(data):
    proc = subprocess.run([exe, 'plugin', 'dev', 'request', plugin, 'workspace.butler', '--json', '--data', json.dumps(data)], capture_output=True, text=True, encoding='utf-8', timeout=45)
    if proc.returncode:
        raise SystemExit('Orca butler settings request failed; local credentials were not printed, inspect plugin logs')
    return json.loads(proc.stdout)['result']['result']
current = request({'operation': 'read'})
if current['entries'] and (current['port'] != 9901 or current['url'] != 'http://127.0.0.1:9900'):
    raise SystemExit('Existing butler messages use other endpoints; inspect before changing')
request({'operation': 'save', 'revision': current['revision'], 'enabled': True, 'port': 9901, 'url': 'http://127.0.0.1:9900', 'inboundToken': inbound, 'outboundToken': outbound})
config_path.write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False), encoding='utf-8')
env_path.write_text(env, encoding='utf-8')
(home / 'daily').mkdir(exist_ok=True)
target = home / 'skills/agentboat-butler'
target.mkdir(parents=True, exist_ok=True)
shutil.copy2(root / 'skill/agentboat-butler/SKILL.md', target / 'SKILL.md')
print(json.dumps({'configured': True, 'hermesPort': 9900, 'orcaPort': 9901, 'host': '127.0.0.1', 'approvals': 'manual; unattended/cron deny', 'credentialsPrinted': False}))
