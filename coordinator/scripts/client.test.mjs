import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('butler CLI maps read/check/send/reply and takes message JSON only from stdin', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'butler-client-'));
  const fixture = path.join(dir, 'orca-fixture.mjs');
  writeFileSync(fixture, `import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
cp.execFileSync = (_exe, args) => JSON.stringify({handler:args[4],input:JSON.parse(args[args.indexOf('--data')+1])});
syncBuiltinESMExports();`);
  try {
    for (const operation of ['read', 'check', 'send', 'reply']) {
      const input = {runId:'mock-main',requestId:'mock-request',contextId:'mock-context',id:'mock-task',text:'模拟日常消息'};
      const value = JSON.parse(execFileSync(process.execPath, ['--import', pathToFileURL(fixture).href, 'scripts/client.mjs', 'butler-'+operation], {encoding:'utf8',windowsHide:true,input:JSON.stringify(input)}));
      assert.equal(value.handler, 'workspace.butler');
      assert.deepEqual(value.input, ['read','check'].includes(operation) ? {operation} : {...input,operation});
    }
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('main-bind queries in its own process without --from and overwrites supplied identity', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'main-bind-client-'));
  const fixture = path.join(dir, 'orca-fixture.mjs');
  writeFileSync(fixture, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
cp.execFileSync = (_exe, args) => {
  if (args[0] === 'orchestration') {
    if (args.includes('--from')) throw Error('chatNotDeclarable');
    return JSON.stringify({ok:true,result:{run:process.env.TEST_NO_RUN ? null : {id:'run_self'}}});
  }
  const input = JSON.parse(args[args.indexOf('--data') + 1]);
  return JSON.stringify({input});
};
syncBuiltinESMExports();`);
  try {
    const call = (chat, extra = {}) => execFileSync(process.execPath, ['--import', pathToFileURL(fixture).href, 'scripts/client.mjs', 'main-bind', '--check'], {
      encoding: 'utf8', windowsHide: true,
      input: JSON.stringify({runId:'run_self',caller:'forged',currentRunId:'run_forged',token:'test-only'}),
      env: {...process.env, ORCA_AGENT_SESSION_ID:chat ? 'test-chat' : '', ORCA_TERMINAL_HANDLE:'test-terminal', ...extra}, stdio:['pipe','pipe','pipe']
    });
    for (const chat of [true, false]) {
      const {input} = JSON.parse(call(chat));
      assert.equal(input.caller, chat ? 'orca_session_id:test-chat' : 'test-terminal');
      assert.equal(input.currentRunId, 'run_self'); assert.equal(input.checkOnly, true);
    }
    assert.throws(() => call(true, {TEST_NO_RUN:'1'}), /没有协调 Run/);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
