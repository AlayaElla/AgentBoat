import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientPath, roleRegistryPath } from '../../coordinator/scripts/orca-cli.mjs';

test('Claude role hooks scope actions by Orca identity and fail open', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'agentboat-hook-')), main = path.join(temp, 'main'),
    project = path.join(temp, 'project'), home = path.join(temp, 'home'), transcript = path.join(temp, 'transcript.jsonl');
  const env = { ...process.env, ORCA_USER_DATA_PATH: temp, AGENTBOAT_HOME: home, NODE_OPTIONS: '' };
  const registry = roleRegistryPath(process.platform, env);
  const sessions = {
    'orca_session_id:claude_workspace': { role: 'workspace-main', directory: main, summary: '工作间待处理 1 组' },
    'orca_session_id:claude_project': { role: 'project-lead', projectId: 'p1', summary: '待验收 1 项' }
  };
  const hook = fileURLToPath(new URL('./hook.mjs', import.meta.url));
  const run = (id, input) => {
    const p = spawnSync(process.execPath, [hook], { encoding: 'utf8', input: typeof input === 'string' ? input : JSON.stringify({ cwd: main, ...input }),
      env: { ...env, ORCA_AGENT_SESSION_ID: id }, windowsHide: true });
    assert.equal(p.status, 0, p.stderr);
    return { decision: p.stdout ? JSON.parse(p.stdout) : null, stderr: p.stderr };
  };
  const pre = (tool, input, id = 'claude_workspace', extra = {}) => run(id, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, ...extra }).decision?.hookSpecificOutput?.permissionDecision;
  const cmd = (command, tool = 'Bash') => pre(tool, { command });
  const stop = (active = false, id = 'claude_project') => run(id, { hook_event_name: 'Stop', transcript_path: transcript, stop_hook_active: active }).decision?.decision;
  const user = text => ({ type: 'user', message: { role: 'user', content: text } });
  const done = user('──── From: WORKER (worker_1) (worker_done)\nSubject: fixture');
  const client = clientPath.replaceAll('\\', '/');
  const assistant = (id, command) => ({ type: 'assistant', cwd: main, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id, input: { command } }] } });
  const result = (id, content, is_error = false) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error, content }] } });
  const setTranscript = (...rows) => writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const receipt = (phase, projectId = 'p1', pendingAcceptance = phase === 'ready') => JSON.stringify({ submission: { phase, projectId, pendingAcceptance, requestId: 'request' }, ok: true });
  try {
    for (const dir of [main, project, path.join(home, 'memory'), path.dirname(registry)]) mkdirSync(dir, { recursive: true });
    assert.equal(run('claude_workspace', '{}').stderr.trim().split('\n').length, 1);
    assert.equal(run('claude_workspace', '{}').decision, null);
    writeFileSync(registry, 'broken');
    assert.equal(run('claude_workspace', '{}').decision, null);
    writeFileSync(registry, JSON.stringify({ version: 1, sessions }));
    for (const source of ['startup', 'resume', 'compact', 'clear']) {
      const session = id => run(id, { hook_event_name: 'SessionStart', source }).decision?.hookSpecificOutput?.additionalContext;
      assert.match(session('claude_workspace'), /工作间管理员.*[\s\S]+工作间待处理 1 组/);
      assert.match(session('claude_project'), /项目管理员.*[\s\S]+待验收 1 项/);
      assert.equal(session('claude_worker'), undefined);
    }
    assert.equal(run('claude_workspace', 'bad input').decision, null);
    assert.equal(pre('Write', { file_path: path.join(main, 'new/subfile.txt') }), undefined);
    assert.equal(pre('Edit', { file_path: path.join(home, 'memory/log.md') }), undefined);
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      const item = { [tool === 'NotebookEdit' ? 'notebook_path' : 'file_path']: path.join(project, 'code.txt') };
      assert.equal(pre(tool, item), 'deny', tool);
      assert.equal(pre(tool, item, 'claude_project'), undefined);
      assert.equal(pre(tool, item, 'claude_worker'), undefined);
      assert.equal(pre(tool, item, 'claude_workspace', { agent_id: 'native-subagent' }), undefined);
    }
    symlinkSync(project, path.join(main, 'shortcut'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(pre('Write', { file_path: path.join(main, 'shortcut/new.txt') }), 'deny');

    for (const command of ['ls', 'rg --line-number todo', 'find . -name "*.md" -print', 'orca orchestration check --json',
      'orca orchestration worker-start --spec "execute delegated work"', 'git status --short', 'git log --oneline',
      'node "' + client + '" overview', 'node "' + client + '" main-bind < input.json',
      "printf '%s' '{\"text\":\"message\"}' | node \"" + client + '" links-send',
      'git -C "' + path.join(home, 'memory').replaceAll('\\', '/') + '" add notes.md']) assert.equal(cmd(command), undefined, command);
    for (const command of ['npm run build', 'node -e "42"', 'node ./outside.mjs', 'orca terminal send --text "npm run build"', 'find . -delete',
      'rg --pre=sh todo', 'git diff --output=save.txt', 'git -C "' + project.replaceAll('\\', '/') + '" add code.txt',
      'cat input.txt > output.txt', 'ls && npm run build', 'ls; npm run build', 'ls | npm run build', 'cat "$(command)"']) assert.equal(cmd(command), 'deny', command);
    for (const command of ['Get-ChildItem -LiteralPath .', 'Get-Content -Raw input.json | node "' + client + '" main-bind',
      'git -C "$env:AGENTBOAT_HOME/memory" add notes.md', "'{\"text\":\"note\"}' | node \"" + client + '" links-send']) assert.equal(cmd(command, 'PowerShell'), undefined, command);
    for (const command of ['Set-Content code.txt "write"', 'Get-Content input.txt; Set-Content code.txt new',
      'Get-Content "$(Invoke-Expression code)"', 'Get-ChildItem | Remove-Item']) assert.equal(cmd(command, 'PowerShell'), 'deny', command);
    assert.equal(cmd('npm run build', 'Monitor'), 'deny');

    setTranscript(user('normal message with worker_done mentioned'));
    assert.equal(stop(), undefined);
    setTranscript(done);
    assert.equal(stop(), 'block');
    assert.equal(stop(true), undefined);
    assert.equal(stop(false, 'claude_workspace'), undefined);
    assert.equal(stop(false, 'claude_worker'), undefined);
    const submit = assistant('call', 'node "' + client + '" submit input.json');
    for (const reply of [receipt('working'), receipt('ready', 'p2'), receipt('ready', 'p1', false), '{"ok":false}']) {
      setTranscript(done, submit, result('call', reply));
      assert.equal(stop(), 'block');
    }
    setTranscript(done, submit, result('call', receipt('ready'), true));
    assert.equal(stop(), 'block');
    setTranscript(done, submit, result('call', receipt('ready')));
    assert.equal(stop(), undefined);
    setTranscript(done, submit, result('call', 'Exit code 0\n' + receipt('completed').slice(0, -1) + ',"result":{... truncated ...'));
    assert.equal(stop(), undefined);
    setTranscript(done, submit, result('call', receipt('ready')), done);
    assert.equal(stop(), 'block');
    setTranscript(done, user('new turn'));
    assert.equal(stop(), undefined);
    setTranscript(user('check'), assistant('check', 'orca orchestration check --json'), result('check', '{"ok":true,"result":{"messages":[{"type":"worker_done"}]}}'));
    assert.equal(stop(), 'block');
    writeFileSync(transcript, 'invalid JSONL');
    assert.equal(stop(), undefined);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
