import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
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
  return JSON.stringify({input, handler:args[4]});
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
    const projectLead = (command, input) => JSON.parse(execFileSync(process.execPath,
      ['--import', pathToFileURL(fixture).href, 'scripts/client.mjs', command],
      { encoding:'utf8', windowsHide:true, input:JSON.stringify(input), env:{ ...process.env, ORCA_AGENT_SESSION_ID:'project-chat' } }));
    const switchInput = { projectId:'p1', revision:2, mode:'new', agent:'codex', runId:'run_forged' };
    assert.deepEqual(projectLead('project-lead-switch', switchInput), { handler:'workspace.projectLead', input:{ ...switchInput, runId:'run_self' } });
    const bindInput = { projectId:'p1', revision:3, requestId:'project-bind', runId:'run_self', token:'test-only' };
    assert.deepEqual(projectLead('project-lead-bind', bindInput), { handler:'project.agent', input:{
      ...bindInput, operation:'bind', caller:'orca_session_id:project-chat', currentRunId:'run_self' } });
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('main-bind writes both role cards only after a matching receipt and retries file failures safely', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'main-role-client-'));
  const fixture = path.join(dir, 'orca-fixture.mjs');
  const start = '<!-- AgentBoat:workspace-role:start -->', end = '<!-- AgentBoat:workspace-role:end -->';
  writeFileSync(fixture, `import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.openSync;
fs.openSync = (file, ...args) => {
  if (process.env.TEST_ROLE_LOCKED && String(file).includes('.agentboat-role-')) throw Error('模拟目录只读');
  return open(file, ...args);
};
cp.execFileSync = (_exe, args) => {
  if (args[0] === 'orchestration') return JSON.stringify({ok:true,result:{run:{id:'run_self'}}});
  return JSON.stringify({ok:!process.env.TEST_ROLE_REJECT,result:{result:{runId:'run_self',session:{path: process.env.TEST_ROLE_DIRECTORY, handle:process.env.TEST_ROLE_HANDLE}}}});
};
syncBuiltinESMExports();`);
  const call = (directory, command = 'main-bind', check = false, env = {}) => JSON.parse(execFileSync(process.execPath,
    ['--import', pathToFileURL(fixture).href, 'scripts/client.mjs', command, ...(check ? ['--check'] : [])], {
      encoding: 'utf8', windowsHide: true, input: JSON.stringify({runId:'run_self',token:'fixture',path:dir}),
      env: {...process.env, ORCA_AGENT_SESSION_ID:'test-chat', TEST_ROLE_HANDLE:'orca_session_id:test-chat', TEST_ROLE_DIRECTORY: directory, ...env}
    }));
  try {
    const first = path.join(dir, 'first'), next = path.join(dir, 'next');
    mkdirSync(first); mkdirSync(next);
    const claude = path.join(first, 'CLAUDE.md'), agents = path.join(first, 'AGENTS.md');
    const original = '\uFEFF# 现有 Claude 说明\r\n保留格式';
    const prefix = '# 现有 AGENTS 说明\r\n\r\n', suffix = '\r\n\r\n# 后面的内容';
    const managed = prefix + start + '\r\n旧角色卡\r\n' + end + suffix;
    writeFileSync(claude, original); writeFileSync(agents, managed);
    call(first, 'main-bind', true);
    call(first, 'main-bind', false, {TEST_ROLE_HANDLE:'orca_session_id:different'});
    assert.equal(call(first, 'main-bind', false, {TEST_ROLE_REJECT:'1'}).ok, false);
    call(first, 'project-lead-bind');
    assert.equal(readFileSync(claude, 'utf8'), original);
    assert.equal(readFileSync(agents, 'utf8'), managed);
    assert.match(call(first, 'main-bind', false, {TEST_ROLE_LOCKED:'1'}).result.result.roleCardWarning, /绑定已成功.*目录只读/);
    assert.equal(readFileSync(claude, 'utf8'), original);
    assert.equal(readFileSync(agents, 'utf8'), managed);

    assert.equal(call(first).result.result.roleCardWarning, undefined);
    const updated = readFileSync(claude, 'utf8'), replaced = readFileSync(agents, 'utf8');
    assert.ok(updated.startsWith(original + '\r\n\r\n' + start));
    assert.ok(replaced.startsWith(prefix + start) && replaced.endsWith(end + suffix));
    assert.doesNotMatch(replaced, /旧角色卡/);
    assert.match(replaced, /先读 `\$agentboat-workspace`/);
    assert.match(replaced, /你是工作间管理员/);
    call(first);
    assert.equal(readFileSync(claude, 'utf8'), updated);
    assert.equal(readFileSync(agents, 'utf8'), replaced);

    call(next);
    assert.deepEqual(readdirSync(next).sort(), ['AGENTS.md', 'CLAUDE.md']);
    for (const name of readdirSync(next)) {
      const card = readFileSync(path.join(next, name), 'utf8');
      assert.equal(card.split(start).length, 2);
      assert.match(card, /用 `message` 交给项目主会话/);
    }
    assert.equal(readFileSync(claude, 'utf8'), updated);
    assert.equal(readFileSync(agents, 'utf8'), replaced);
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
    const input = { id:'peer', projectId:'p1', revision:0, requestId:'discard', items:[{taskId:'t',kind:'decision',itemId:'d',result:'discarded'}] };
    const inputFile = path.join(dir, 'feedback.json');
    writeFileSync(inputFile, JSON.stringify(input));
    const value = JSON.parse(execFileSync(process.execPath, ['--import', pathToFileURL(fixture).href, 'scripts/client.mjs', 'feedback', inputFile], {encoding:'utf8',windowsHide:true}));
    assert.deepEqual(value, {handler:'workspace.linkFeedback', input});
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('project writes attach the local caller and current Run as optional display metadata', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'project-caller-client-')), fixture = path.join(dir, 'orca-fixture.mjs'), inputFile = path.join(dir, 'input.json');
  writeFileSync(fixture, `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
cp.execFileSync=(_exe,args)=>{if(args[0]==='orchestration'){if(args.includes('--from'))throw Error('wrong identity');if(process.env.TEST_NO_RUN)throw Error('Run unavailable');return JSON.stringify({ok:true,result:{run:{id:'run_current'}}});}return JSON.stringify({input:JSON.parse(args[args.indexOf('--data')+1])});};syncBuiltinESMExports();`);
  try {
    for (const operation of ['bind', 'submit', 'feedback', 'hide', 'restore', 'delete']) for (const mode of ['chat', 'terminal', 'none', 'no-run']) {
      const input = {projectId:'p1',revision:0,requestId:'r',caller:'forged',...(operation==='bind'?{runId:'run_bound'}:{}),
        ...(operation==='feedback'?{items:[{taskId:'t',kind:'decision',itemId:'d',result:'discarded',note:'用户原话'}]}:{})};
      writeFileSync(inputFile, JSON.stringify(input));
      const reply = JSON.parse(execFileSync(process.execPath, ['--import', pathToFileURL(fixture).href, 'scripts/client.mjs', operation, inputFile], {encoding:'utf8',windowsHide:true,env:{...process.env,ORCA_AGENT_SESSION_ID:mode==='chat'||mode==='no-run'?'claude_self':'',ORCA_TERMINAL_HANDLE:mode==='terminal'?'terminal-self':'',TEST_NO_RUN:mode==='no-run'?'1':''}}));
      assert.equal(reply.input.caller, mode==='none'?undefined:mode==='terminal'?'terminal-self':'orca_session_id:claude_self');
      assert.equal(reply.input.runId, operation==='bind'?'run_bound':mode==='none'||mode==='no-run'?undefined:'run_current');
      if (operation === 'feedback') assert.deepEqual(reply.input.items, input.items);
    }
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('submit emits the hook receipt only for the exact saved write and preserves the bridge reply', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'project-submit-client-'));
  const fixture = path.join(dir, 'orca-fixture.mjs'), input = path.join(dir, 'input.json');
  writeFileSync(fixture, "import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; import {createHash} from 'node:crypto';\n" +
    `cp.execFileSync=(_exe,args)=>{
      const raw=args[args.indexOf('--data')+1], input=JSON.parse(raw);
      const fingerprint=process.env.TEST_UNMATCHED?'wrong':createHash('sha256').update(raw).digest('hex');
      const archived=!!process.env.TEST_ARCHIVED, task={...input.task,acceptance:archived?[]:[{status:'pending'}]};
      return JSON.stringify({ok:true,result:{result:{task:archived?task:undefined,project:{
        ref:{id:input.projectId},revision:2,archive:archived?{last:{revision:2,tasks:1}}:undefined,
        tasks:archived?[]:[task],requests:[{id:input.requestId,fingerprint}]
      }}}});
    };syncBuiltinESMExports();`);
  writeFileSync(input, JSON.stringify({ projectId: 'p1', revision: 1, runId: 'run_self', requestId: 'one', task: { id: 't1', phase: 'ready' } }));
  try {
    const call = (unmatched, archived = false) => JSON.parse(execFileSync(process.execPath, ['--import', pathToFileURL(fixture).href, 'scripts/client.mjs', 'submit', input], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, TEST_UNMATCHED: unmatched ? '1' : '', TEST_ARCHIVED: archived ? '1' : '' }
    }));
    const reply = call(false);
    assert.deepEqual(reply.submission, { projectId: 'p1', requestId: 'one', taskId: 't1', phase: 'ready', pendingAcceptance: true, pendingDecision: false });
    assert.equal(reply.result.result.project.ref.id, 'p1');
    assert.equal(call(true).submission, undefined);
    assert.deepEqual(call(false, true).submission, { ...reply.submission, pendingAcceptance: false, archived: { revision: 2, tasks: 1 } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('brief and single-task reads preserve the bridge envelope and omit unrelated state', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'compact-client-')), fixture = path.join(dir, 'orca-fixture.mjs');
  writeFileSync(fixture, `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
const ref={id:'p1',name:'示例',path:'/private/path'}, counts={working:2};
const project={ref, revision:3, tasks:[{id:'t1',title:'一'},{id:'t2',title:'二'}], events:['private']};
const overview={workspace:{runId:'main'},links:['private'],attention:[{title:'待决定'}],questions:[{id:'msg_1'}],projects:[{ref,counts}]};
cp.execFileSync=(_exe,args)=>{const archived=args.includes('--data')&&JSON.parse(args[args.indexOf('--data')+1]).taskId==='old';
return JSON.stringify({ok:true,id:'fixture',result:{result:args[4]==='workspace.overview'?overview:args[4]==='project.agent'?{project,lead:{private:true},...(archived?{task:{id:'old'},archiveStatus:'已归档'}:{})}:null}});};
syncBuiltinESMExports();`);
  const call = (...args) => JSON.parse(execFileSync(process.execPath, ['--import', pathToFileURL(fixture).href, 'scripts/client.mjs', ...args],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  try {
    assert.deepEqual(call('overview', '--brief'), { ok: true, id: 'fixture', result: { result: {
      attention: [{ title: '待决定' }], questions: [{ id: 'msg_1' }], projects: [{ id: 'p1', name: '示例', counts: { working: 2 } }]
    } } });
    assert.equal(call('overview').result.result.workspace.runId, 'main');
    assert.deepEqual(call('read', 'p1', '--task', 't2').result.result, { projectId: 'p1', revision: 3, task: { id: 't2', title: '二' } });
    assert.equal(call('read', 'p1').result.result.project.tasks.length, 2);
    assert.deepEqual(call('read', 'p1', '--task', 'old').result.result, { projectId: 'p1', revision: 3, task: { id: 'old' }, archiveStatus: '已归档' });
    assert.throws(() => call('read', 'p1', '--task', 'absent'), /找不到任务 absent/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the bridge explains approval and reload errors while keeping unrelated validation errors', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'client-reload-'));
  const fixture = path.join(dir, 'orca-fixture.mjs');
  writeFileSync(fixture, `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
cp.execFileSync=()=>{throw Object.assign(Error('CLI rejected'),{stdout:process.env.FIXTURE_REPLY});};syncBuiltinESMExports();`);
  const run = error => execFileSync(process.execPath, ['--import', pathToFileURL(fixture).href, 'scripts/client.mjs', 'overview'],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore','pipe','pipe'], env: { ...process.env, FIXTURE_REPLY: JSON.stringify({ok:false,error}) } });
  try {
    for (const error of [
      {code:'approval_required'},
      {code:'invalid_argument',message:'local.project-coordinator is not approved and enabled, so its worker cannot run.'},
      {code:'plugin_request_failed',data:{requestCode:'unavailable'}}
    ]) assert.throws(() => run(error), /插件正在重载或等待批准/);
    assert.throws(() => run({code:'invalid_argument',message:'the caller used malformed JSON'}), /the caller used malformed JSON/);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
