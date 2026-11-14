import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const sandbox = path.resolve(process.env.AGENTBOAT_SANDBOX || path.join(os.tmpdir(), 'agentboat-sandbox'));
mkdirSync(sandbox, { recursive: true });
const testHome = mkdtempSync(path.join(sandbox, 'agentboat-demo-unit-'));
process.env.AGENTBOAT_HOME = testHome;
process.env.AGENTBOAT_TEST_ONLY = '1';
const api = await import('./workspace.mjs');

test('初始化不覆盖模板；记忆按来源隔离、带日期、重复记录拒绝追加', () => {
  try {
    api.init();
    assert.equal(api.template('code').roles.code.agent, 'codex');
    const custom = path.join(testHome, 'templates/code.json');
    const value = JSON.parse(readFileSync(custom));
    value.name = '自定义';
    writeFileSync(custom, JSON.stringify(value));
    api.init();
    assert.equal(api.template('code').name, '自定义');
    assert.throws(() => api.template('../escape'));
    const entry = { id: 'fact-1', kind: 'user', date: '2026-11-14T00:00:00Z', source: '测试主人 / msg-1', text: '偏好短回答' };
    api.remember(entry);
    const user = readFileSync(path.join(testHome, 'memory/user.md'), 'utf8');
    assert.match(user, /2026-11-14T00:00:00.000Z/);
    assert.match(user, /测试主人 \/ msg-1/);
    assert.throws(() => api.remember(entry), /已存在/);
    assert.equal(readFileSync(path.join(testHome, 'memory/user.md'), 'utf8'), user);
    api.remember({ ...entry, id: 'infer-1', kind: 'inference', text: '未经确认的推断' });
    api.remember({ ...entry, id: 'external-1', kind: 'external', workspaceId: 'other', text: '外部内容' });
    assert.doesNotMatch(readFileSync(path.join(testHome, 'memory/user.md'), 'utf8'), /推断|外部内容/);
    assert.match(readFileSync(path.join(testHome, 'memory/external/other.md'), 'utf8'), /外部内容/);
    assert.match(execFileSync('git', ['ls-files'], { cwd: path.join(testHome, 'memory'), encoding: 'utf8' }), /user.md/);
    assert.throws(() => api.remember({ ...entry, kind: 'external', workspaceId: '../escape' }));
    assert.throws(() => api.remember({ ...entry, id: 'bad-date', date: 'bad' }));
    api.testPath(path.join(sandbox, 'agentboat-demo-project'));
    assert.throws(() => api.testPath(path.join(path.dirname(sandbox), 'AgentBoat')));
    assert.throws(() => api.testPath(`${sandbox}-other/agentboat-demo-project`));
    assert.throws(() => api.testPath(path.join(sandbox, 'real-project')));
    assert.equal(existsSync(path.join(testHome, 'memory/.git')), true);
    const launch = { outcome: { handle: 'agent-1' }, prompt: { outcome: 'journaled' } };
    assert.equal(api.launchReceipt(launch), 'agent-1');
    assert.equal(api.launchReceipt({ launch }), 'agent-1');
    assert.throws(() => api.launchReceipt({ outcome: { handle: 'agent-1' }, prompt: { outcome: 'unknown' } }));
  } finally {
    const resolved = path.resolve(testHome);
    assert.equal(path.dirname(resolved), sandbox);
    assert.match(path.basename(resolved), /^agentboat-demo-unit-/);
    rmSync(resolved, { recursive: true, force: true });
  }
});
