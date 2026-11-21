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
  const env = { ...process.env, ORCA_USER_DATA_PATH: temp, AGENTBOAT_HOME: home, TEMP: temp, NODE_OPTIONS: '' };
  const registry = roleRegistryPath(process.platform, env);
  const sessions = {
    'orca_session_id:10000000-0000-4000-9000-000000000001': { role: 'workspace-main', directory: main, bot: true },
    'orca_session_id:10000000-0000-4000-9000-000000000002': { role: 'workspace-main', directory: main },
    'orca_session_id:claude_workspace': { role: 'workspace-main', directory: main, summary: '工作间待处理 1 组' },
    'orca_session_id:claude_project': { role: 'project-lead', projectId: 'p1', summary: '待验收 1 项' },
    'orca_session_id:codex_workspace': { role: 'workspace-main', directory: main, summary: '工作间待处理 1 组' },
    'orca_session_id:codex_project': { role: 'project-lead', projectId: 'p1', runId: 'run_fixture', summary: '待验收 1 项' }
  };
  const hook = fileURLToPath(new URL('./hook.mjs', import.meta.url));
  const run = (id, input) => {
    const p = spawnSync(process.execPath, [hook, ...(id.startsWith('codex_') ? ['--codex'] : [])], { encoding: 'utf8', input: typeof input === 'string' ? input : JSON.stringify({ cwd: main, ...input }),
      env: { ...env, ORCA_AGENT_SESSION_ID: id }, windowsHide: true });
    assert.equal(p.status, 0, p.stderr);
    return { decision: p.stdout ? JSON.parse(p.stdout) : null, stderr: p.stderr };
  };
  const pre = (tool, input, id = 'claude_workspace', extra = {}) => run(id, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, ...extra }).decision?.hookSpecificOutput?.permissionDecision;
  const cmd = (command, tool = 'Bash') => pre(tool, { command });
  const stop = (active = false, id = 'claude_project') => run(id, { hook_event_name: 'Stop', transcript_path: transcript, stop_hook_active: active }).decision?.decision;
  const user = text => ({ type: 'user', message: { role: 'user', content: text } });
  const done = { ...user('──── From: WORKER (worker_1) (worker_done) ────\nSubject: fixture'),
    uuid: 'fixture-message-uuid', turnOrigin: 'sdk', promptSource: 'sdk', turnPosition: { promptIndex: 0, turnIndex: 18 } };
  const client = clientPath.replaceAll('\\', '/');
  const assistant = (id, command) => ({ type: 'assistant', cwd: main, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id, input: { command } }] } });
  const result = (id, content, is_error = false) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error, content }] } });
  const setTranscript = (...rows) => writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const receipt = (phase, projectId = 'p1', pendingAcceptance = phase === 'ready', pendingDecision = false) => JSON.stringify({
    submission: { projectId, revision: 2, requestId: 'request', taskId: 't1', phase, pendingAcceptance, pendingDecision }, ok: true,
    result: { result: { projectId, revision: 2, project: { ref: { id: projectId }, revision: 2, runId: 'run_fixture' } } }
  });
  try {
    for (const dir of [main, project, path.join(home, 'memory'), path.dirname(registry)]) mkdirSync(dir, { recursive: true });
    assert.equal(run('claude_workspace', '{}').stderr.trim().split('\n').length, 1);
    assert.equal(run('claude_workspace', '{}').decision, null);
    writeFileSync(registry, 'broken');
    assert.equal(run('claude_workspace', '{}').decision, null);
    writeFileSync(registry, JSON.stringify({ version: 1, sessions }));
    for (const command of ['orca bot item list', 'orca automations list', 'orca bot reply', 'orca computer list-apps']) {
      assert.equal(pre('Bash', { command }, '10000000-0000-4000-9000-000000000001'), 'deny');
      assert.equal(pre('Bash', { command }, '10000000-0000-4000-9000-000000000002'), undefined);
    }
    for (const source of ['startup', 'resume', 'compact', 'clear']) {
      const session = id => run(id, { hook_event_name: 'SessionStart', source }).decision?.hookSpecificOutput?.additionalContext;
      assert.match(session('claude_workspace'), /工作间管理员.*[\s\S]+工作间待处理 1 组/);
      assert.match(session('claude_project'), /项目管理员.*[\s\S]+待验收 1 项/);
      assert.equal(session('claude_worker'), undefined);
    }
    assert.equal(run('claude_workspace', 'bad input').decision, null);
    assert.equal(pre('Write', { file_path: path.join(main, 'new/subfile.txt') }), undefined);
    assert.equal(pre('Edit', { file_path: path.join(home, 'memory/log.md') }), undefined);
    for (const file_path of ['memory/.git/config', '.ClAuDe/settings.json', '.CODEX\\config.toml', 'nested/../.git/config', '.git']) {
      assert.equal(pre('Write', { file_path }), 'deny', file_path);
    }
    mkdirSync(path.join(main, '.git'));
    symlinkSync(path.join(main, '.git'), path.join(main, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(pre('Edit', { file_path: 'alias/config' }), 'deny');
    assert.equal(pre('Edit', { file_path: '.gitignore' }), undefined);
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
      'git -C "' + path.join(home, 'memory').replaceAll('\\', '/') + '" add notes.md',
      'git -C "' + path.join(home, 'memory').replaceAll('\\', '/') + '" commit -m "notes"']) assert.equal(cmd(command), undefined, command);
    for (const command of ['npm run build', 'node -e "42"', 'node ./outside.mjs', 'orca terminal send --text "npm run build"', 'find . -delete',
      'rg --pre=sh todo', 'git diff --output=save.txt', 'git -C "' + project.replaceAll('\\', '/') + '" add code.txt',
      'ls && npm run build', 'ls; npm run build', 'ls | npm run build', 'cat "$(command)"']) assert.equal(cmd(command), 'deny', command);
    for (const command of ['Get-ChildItem -LiteralPath .', 'Get-Content -Raw input.json | node "' + client + '" main-bind',
      'git -C "$env:AGENTBOAT_HOME/memory" add notes.md', "'{\"text\":\"note\"}' | node \"" + client + '" links-send']) assert.equal(cmd(command, 'PowerShell'), undefined, command);
    for (const command of ['Set-Content code.txt "write"', 'Get-Content input.txt; Set-Content code.txt new',
      'Get-Content "$(Invoke-Expression code)"', 'Get-ChildItem | Remove-Item']) assert.equal(cmd(command, 'PowerShell'), 'deny', command);
    const overview = 'node "' + client + '" overview --brief';
    const outside = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/');
    const scratch = path.join(outside, 'fake-scratch');
    for (const command of [overview + ' | grep pending | head -n 2 > overview.txt',
      overview + " | jq -r '.projects[] | .name' >> overview.txt",
      overview + ' | grep "literal | < > & ;" > "' + path.join(temp, 'out.txt').replaceAll('\\', '/') + '"',
      overview + ' > "$AGENTBOAT_HOME/overview.json"',
      'orca orchestration reply --id msg_test --body "引号 \\" 和 | ; > < &"']) assert.equal(cmd(command), undefined, command);
    for (const command of [overview + " | jq 'system(\"npm run build\")'", overview + " | jq -nf filter.jq",
      overview + " | jq 'include \"remote\"; .'", overview + ' | rg --pre cmd', overview + ' | head | tee output.txt',
      overview + ' > "' + outside + 'out.txt"', overview + ' > ../elsewhere.txt', overview + ' > file.txt 2>&1',
      overview + ' > "$(command)"', overview + ' 2> output.txt', overview + ' | | head',
      'orca orchestration reply --id msg_test --body "没闭合 | head']) assert.equal(cmd(command), 'deny', command);
    assert.equal(cmd(overview + ' | ConvertFrom-Json | Select-Object result | Select-String "data >" >> "$env:AGENTBOAT_HOME/out.txt"', 'PowerShell'), undefined);
    assert.equal(cmd(overview + ' | findstr "pending" > overview.txt', 'PowerShell'), undefined);
    assert.equal(cmd(overview + ' > "$env:TEMP/overview.txt"', 'PowerShell'), undefined);
    assert.equal(cmd("orca orchestration reply --id msg_test --body '正文 ''括号'' 仍是 “资料” | ; > < &'", 'PowerShell'), undefined);
    assert.equal(cmd(overview + ' | Select-Object @{Expression={Set-Content . write}}', 'PowerShell'), 'deny');
    assert.equal(cmd(overview + ' > "C:/a/*/elsewhere.txt"', 'PowerShell'), 'deny');
    assert.equal(pre('Bash', { command: overview + ' > "' + path.join(scratch, 'out.txt').replaceAll('\\', '/') + '"' }, 'claude_workspace', { scratchpad_dir: scratch }), undefined);
    const send = 'orca orchestration send --subject "hook fixture" --body ';
    for (const tool of ['Bash', 'PowerShell']) {
      for (const quote of ["'", '"']) for (const body of [
        '请核对示例任务\n见 orca orchestration reply、node -e 和 overview --brief。',
        '示例反馈\r\nnode client.mjs main-read | node -e ...\n2>&1 | head -2；重定向 > D:/Example/x.json',
        'client.mjs main-read 的输出交给 node -e 解析\norca orchestration reply 后面接 head'
      ]) assert.equal(cmd(send + quote + body + quote, tool), undefined);
      assert.equal(cmd(send + '"正文\n没有封口', tool), 'deny');
      assert.equal(cmd(send + "'正文\n没有封口", tool), 'deny');
      assert.equal(cmd(send + '"正文\n$(echo outside)"', tool), 'deny');
      assert.equal(cmd(send + '"正文"\nnode -e "42"', tool), 'deny');
    }
    assert.equal(cmd(send + '"正文\n`echo outside`"'), 'deny');
    assert.equal(cmd(send + '"正文\n$AGENTBOAT_HOME/memory"'), 'deny');
    assert.equal(cmd(send + '"路径 D:\\Example\n正文"'), undefined);
    assert.equal(cmd('for id in msg_example; do orca orchestration reply --id $id --body "回复"; done'), 'deny');
    symlinkSync(outside, path.join(main, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(cmd(overview + ' > outside/out.txt'), 'deny');
    assert.equal(cmd('npm run build', 'Monitor'), 'deny');
    for (const command of ['orca plugin list --json', 'orca plugin logs local.project-coordinator', 'orca plugin update alayaella.agentboat', 'orca plugin update alayaella.agentboat --json']) {
      assert.equal(cmd(command), undefined);
      assert.equal(pre('Bash', { command }, 'codex_workspace'), undefined);
    }
    for (const command of ['orca plugin update alayaella.agentboat --approve', 'orca plugin update other.plugin',
      'orca plugin update alayaella.agentboat --json --approve', 'orca plugin uninstall alayaella.agentboat',
      'orca plugin install .', 'orca plugin enable local.project-coordinator'])
      assert.equal(pre('Bash', { command }, 'codex_workspace'), 'deny');

    assert.match(run('codex_workspace', { hook_event_name: 'SessionStart', source: 'startup', transcript_path: transcript, session_id: 'native-fixture' }).decision.hookSpecificOutput.additionalContext, /工作间管理员/);
    assert.equal(run('codex_worker', { hook_event_name: 'SessionStart' }).decision, null);
    assert.equal(pre('Bash', { command: 'npm run build' }, 'codex_workspace'), 'deny');
    assert.equal(pre('Bash', { command: 'npm run build' }, 'codex_project'), undefined);
    assert.equal(pre('Bash', { command: 'npm run build' }, 'codex_worker'), undefined);
    const patch = (...instructions) => ({ command: ['*** Begin Patch', ...instructions, '*** End Patch'].join('\n') });
    assert.equal(pre('apply_patch', patch('*** Add File: ok.txt', '+ok'), 'codex_workspace'), undefined);
    assert.equal(pre('apply_patch', patch('*** Delete File: ' + path.join(project, 'no.txt')), 'codex_workspace'), 'deny');
    assert.equal(pre('apply_patch', patch('*** Update File: ok.txt', '*** Move to: ' + path.join(project, 'no.txt'), '@@', '-a', '+b'), 'codex_workspace'), 'deny');
    assert.equal(pre('apply_patch', patch('*** Delete File: ' + path.join(project, 'no.txt')), 'codex_worker'), undefined);

    setTranscript(user('normal message with worker_done mentioned'));
    assert.equal(stop(), undefined);
    setTranscript(done);
    assert.equal(stop(), 'block');
    assert.equal(stop(true), undefined);
    assert.equal(stop(false, 'claude_workspace'), undefined);
    assert.equal(stop(false, 'claude_worker'), undefined);
    const submit = assistant('call', 'node "' + client + '" submit input.json');
    for (const reply of [receipt('ready', 'p2'), '{"ok":false}', '提交回执待核对，请用 read "p1" --task "t1" 核对。']) {
      setTranscript(done, submit, result('call', reply));
      assert.equal(stop(), 'block');
    }
    setTranscript(done, submit, result('call', receipt('ready'), true));
    assert.equal(stop(), undefined);
    setTranscript(done, submit, result('call', '{"submission":{incomplete},"ok":true}'));
    assert.equal(stop(), 'block');
    setTranscript(done, submit, result('call', receipt('ready')));
    assert.equal(stop(), undefined);
    setTranscript(done, submit, result('call', 'Exit code 0\n' + receipt('completed').split(',"result":')[0] + ',"result":{... truncated ...'));
    assert.equal(stop(), undefined);
    setTranscript(done, submit, result('call', receipt('ready')), { ...done, uuid: 'new-message-uuid' });
    assert.equal(stop(), 'block');
    setTranscript(done, user('new turn'));
    assert.equal(stop(), 'block');
    const check = assistant('check', 'orca orchestration check --json');
    const checked = (id = 'msg_done') => result('check', JSON.stringify({ ok: true, result: { messages: [{ id, type: 'worker_done' }] } }));
    setTranscript(user('check'), check, checked());
    assert.equal(stop(), 'block');
    const composite = { ...assistant('compound', `receipt=receipt.json; node "${client}" submit "$receipt" | head -1`), uuid: 'assistant-message-uuid' };
    const compoundOutput = { ...result('compound', 'summary: ' + receipt('working') + '\nfinished'), uuid: 'tool-message-uuid', sourceToolAssistantUUID: composite.uuid, toolUseResult: { stdout: receipt('working'), stderr: '', interrupted: false } };
    const injected = { ...done, type: 'system', isMeta: true, messageId: 'msg_done' };
    setTranscript(injected, composite, compoundOutput, { type: 'api-request-blob', message: done.message, hash: 'cached mirror' }, check, checked());
    assert.equal(stop(), undefined);
    setTranscript(injected, composite, compoundOutput, check, checked('msg_new_done'));
    assert.equal(stop(), 'block');
    setTranscript(done, composite, compoundOutput, done);
    assert.equal(stop(), undefined);
    setTranscript(user('──── From: Worker (dispatch:fixture) (status) ────\n引用之前的消息：\n' + done.message.content));
    assert.equal(stop(), undefined);
    const question = (id = 'msg_owner', body = '请主人在浏览器登录面板。') => user(
      `──── From: Worker (dispatch:fixture) (question) ────\nSubject: Question\n\n${body}\n\n[Reply: orca orchestration reply --id ${id} --body "..."]`);
    setTranscript(question('msg_code', '测试文件放在哪？'));
    assert.equal(stop(), undefined);
    setTranscript(question());
    assert.match(run('claude_project', { hook_event_name: 'Stop', transcript_path: transcript }).decision.reason, /主人.*submit/);
    assert.equal(stop(true), undefined);
    for (const [reply, blocked] of [[receipt('working'), true], [receipt('blocked', 'p2'), true],
      [receipt('blocked'), false], [receipt('working', 'p1', false, true), false]]) {
      setTranscript(question(), submit, result('call', reply));
      assert.equal(stop(), blocked ? 'block' : undefined);
    }
    const reply = (id = 'msg_owner', body = '--body "处理好了 | > ;"') => assistant('reply', `orca orchestration reply --id ${id} ${body} --json`);
    const accepted = '{"ok":true,"result":{"messageId":"msg_reply_receipt"}}';
    for (const [id, output, failed, blocked] of [['msg_wrong', accepted, false, true], ['msg_owner', '{"ok":false}', false, true],
      ['msg_owner', accepted, true, true], ['msg_owner', accepted, false, false], ['msg_owner', 'Replied msg_reply_receipt', false, false]]) {
      setTranscript(question(), reply(id), result('reply', output, failed));
      assert.equal(stop(), blocked ? 'block' : undefined);
    }
    for (const [args, expected] of [['--body-file "long reply.txt"', undefined], ['--body-file -', undefined],
      ['--body "重试" --retry-request req_fixture', undefined], ['--body-file - --unknown value', 'block']]) {
      setTranscript(question(), reply('msg_owner', args), result('reply', accepted));
      assert.equal(stop(), expected, args);
    }
    setTranscript(question(), question('msg_second'), reply(), result('reply', accepted));
    assert.equal(stop(), 'block');
    setTranscript(question(), done, submit, result('call', receipt('blocked')));
    assert.equal(stop(), undefined);
    setTranscript(user('查看收件箱'), assistant('q', 'orca orchestration check --json'), result('q',
      '{"ok":true,"result":{"messages":[{"id":"msg_owner","type":"question","body":"请主人扫码"}]}}'));
    assert.equal(stop(), 'block');
    const rollout = payload => ({ type: 'response_item', timestamp: '2026-11-19T00:00:00.000Z', payload });
    const codexMail = rollout({ type: 'message', role: 'user', id: 'msg_codex', content: [{ type: 'input_text', text: done.message.content }] });
    const codexCheck = rollout({ type: 'function_call', name: 'exec_command', call_id: 'codex-check', arguments: '{"cmd":"orca orchestration check --json"}' });
    const codexResult = (id, output) => rollout({ type: 'function_call_output', call_id: id, output });
    const report = { type: 'worker_done', id: 'msg_specific', run_id: 'run_fixture', created_at: '2026-11-19T00:00:00.000Z', payload: { taskId: 'orca-task', dispatchId: 'ctx_fixture' } };
    const structuredMail = codexResult('codex-check', JSON.stringify({ ok: true, result: { messages: [report] } }));
    const codexSubmit = rollout({ type: 'function_call', name: 'exec_command', call_id: 'codex-submit', arguments: JSON.stringify({ cmd: 'prefix; node client.mjs submit fixture.json' }) });
    const codexReceipt = (taskId, submittedAt, phase = 'working') => codexResult('codex-submit', JSON.stringify({ submission: {
      projectId: 'p1', revision: 2, requestId: 'req-1', taskId, phase, submittedAt, pendingAcceptance: false, pendingDecision: false
    }, ok: true, result: { result: { projectId: 'p1', revision: 2, project: { ref: { id: 'p1' }, revision: 2, runId: 'run_fixture' } } } }));
    setTranscript(codexMail);
    assert.equal(stop(false, 'codex_project'), 'block');
    setTranscript(codexCheck, structuredMail, codexSubmit, codexReceipt('other-task', '2026-11-19T00:01:00.000Z'));
    assert.equal(stop(false, 'codex_project'), undefined);
    setTranscript(codexCheck, structuredMail, codexSubmit, codexReceipt('orca-task', '2026-11-18T23:59:00.000Z'));
    assert.equal(stop(false, 'codex_project'), 'block');
    setTranscript(codexCheck, structuredMail, codexSubmit, codexReceipt('orca-task', '2026-11-19T00:01:00.000Z'));
    assert.equal(stop(false, 'codex_project'), undefined);
    setTranscript(codexCheck, structuredMail, codexSubmit, codexReceipt('other-task', '2026-11-19T00:01:00.000Z', 'blocked'));
    assert.equal(stop(false, 'codex_project'), undefined);
    setTranscript(codexMail);
    assert.equal(stop(true, 'codex_project'), undefined);
    writeFileSync(transcript, 'invalid JSONL');
    assert.equal(stop(), undefined);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
