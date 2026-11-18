import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

test('connection and link CLI take message JSON from stdin', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'connection-client-'));
  const fixture = path.join(dir, 'orca-fixture.mjs');
  writeFileSync(fixture, `import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
cp.execFileSync = (_exe, args) => JSON.stringify({handler:args[4],input:JSON.parse(args[args.indexOf('--data')+1])});
syncBuiltinESMExports();`);
  try {
    for (const operation of ['read', 'check', 'send', 'reply']) {
      const input = {name:'Hermes',runId:'mock-main',requestId:'mock-request',contextId:'mock-context',id:'mock-task',text:'模拟日常消息'};
      const value = JSON.parse(execFileSync(process.execPath, ['--import', pathToFileURL(fixture).href, 'scripts/client.mjs', 'connection-'+operation, 'Hermes'], {encoding:'utf8',windowsHide:true,input:JSON.stringify(input)}));
      assert.equal(value.handler, 'workspace.connections');
      assert.deepEqual(value.input, ['read','check'].includes(operation) ? {operation,name:'Hermes'} : {...input,operation});
    }
    for (const message of [{ text: '模拟主 agent 消息' }, { files: [path.join(dir, 'fixture.png')] }]) {
      const input = { id: 'local-connection', runId: 'mock-main', requestId: 'mock-message', ...message };
      const value = JSON.parse(execFileSync(process.execPath, ['--import', pathToFileURL(fixture).href, 'scripts/client.mjs', 'links-send'], { encoding: 'utf8', windowsHide: true, input: JSON.stringify(input) }));
      assert.deepEqual(value, { handler: 'workspace.links', input: { ...input, operation: 'send' } });
    }
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('project writes attach the local caller and current Run as optional display metadata', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'project-caller-client-')), fixture = path.join(dir, 'orca-fixture.mjs'), inputFile = path.join(dir, 'input.json');
  writeFileSync(fixture, `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
cp.execFileSync=(_exe,args)=>{if(args[0]==='orchestration'){if(args.includes('--from'))throw Error('wrong identity');if(process.env.TEST_NO_RUN)throw Error('Run unavailable');return JSON.stringify({ok:true,result:{run:{id:'run_current'}}});}return JSON.stringify({input:JSON.parse(args[args.indexOf('--data')+1])});};syncBuiltinESMExports();`);
  try {
    for (const operation of ['bind', 'submit', 'feedback', 'hide', 'restore', 'delete']) for (const mode of ['chat', 'terminal', 'none', 'no-run']) {
      const input = {projectId:'p1',revision:0,requestId:'r',caller:'forged',...(operation==='bind'?{runId:'run_bound'}:{})};
      writeFileSync(inputFile, JSON.stringify(input));
      const reply = JSON.parse(execFileSync(process.execPath, ['--import', pathToFileURL(fixture).href, 'scripts/client.mjs', operation, inputFile], {encoding:'utf8',windowsHide:true,env:{...process.env,ORCA_AGENT_SESSION_ID:mode==='chat'||mode==='no-run'?'claude_self':'',ORCA_TERMINAL_HANDLE:mode==='terminal'?'terminal-self':'',TEST_NO_RUN:mode==='no-run'?'1':''}}));
      assert.equal(reply.input.caller, mode==='none'?undefined:mode==='terminal'?'terminal-self':'orca_session_id:claude_self');
      assert.equal(reply.input.runId, operation==='bind'?'run_bound':mode==='none'||mode==='no-run'?undefined:'run_current');
    }
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
