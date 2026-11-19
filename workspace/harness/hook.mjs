import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { roleRegistryPath, clientPath } from '../../coordinator/scripts/orca-cli.mjs';
import { readRoleCard } from '../../coordinator/scripts/main-role-card.mjs';

const workspaceDir = fileURLToPath(new URL('../', import.meta.url));
const agentboatHome = path.resolve(process.env.AGENTBOAT_HOME || path.join(os.homedir(), '.agentboat'));
const rules = {
  writes: new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']),
  shells: new Set(['Bash', 'PowerShell', 'Monitor']),
  reads: new Set(['ls', 'cat', 'head', 'tail', 'rg', 'grep', 'find', 'pwd', 'get-childitem', 'get-content', 'get-location', 'test-path']),
  gitRead: new Set(['status', 'log', 'diff', 'show']),
  gitMemory: new Set(['add', 'commit']),
  find: new Set(['-name', '-iname', '-path', '-ipath', '-type', '-maxdepth', '-mindepth', '-print']),
  orca: new Set(['status', 'search', 'skills get', 'skills list', 'project list', 'repo list', 'worktree ps', 'worktree list', 'terminal list', 'agent list',
    ...['run-create', 'run-current', 'run-list', 'run-show', 'send', 'check', 'reply', 'inbox', 'task-create', 'task-list', 'task-update', 'worker-start', 'worker-list', 'worker-show', 'worker-read', 'worker-stop', 'worker-release', 'worker-abandon', 'worker-keep-open', 'request-show', 'dispatch-show', 'dispatch', 'ask', 'gate-list', 'gate-resolve'].map(op => 'orchestration ' + op)]),
  scripts: new Map([
    [path.join(workspaceDir, 'workspace.mjs'), new Set(['init', 'templates', 'create', 'dispatch', 'remember'])],
    [path.join(workspaceDir, 'project-skills.mjs'), new Set(['validate'])]
  ])
};
const redirect = '你是工作间管理员：这类操作交给项目主会话（client.mjs message）或用 workspace.mjs dispatch 派 agent。';
const stopReason = '执行者已回报：先核对成果，用 submit 交成待验收（或写明不需要验收的原因、标 completed），再结束。';
const diagnostic = error => console.error('AgentBoat hook：' + (error.code || error.name || '读取失败'));
const same = (a, b) => path.relative(a, b) === '';
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
function shellPath(cwd, value, bash) {
  if (process.platform === 'win32' && bash) value = value.replace(/^\/([a-z])\//i, '$1:/');
  return path.resolve(cwd, value);
}

// Resolve through the nearest existing parent, including junction and symlink targets.
function canonical(file) {
  try { lstatSync(file); }
  catch (e) {
    if (e.code !== 'ENOENT' || path.dirname(file) === file) throw e;
    return path.join(canonical(path.dirname(file)), path.basename(file));
  }
  return realpathSync(file);
}
function writeAllowed(input, role) {
  const file = input.tool_name === 'NotebookEdit' ? input.tool_input?.notebook_path : input.tool_input?.file_path;
  if (typeof file !== 'string' || !file || typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd) || file.split(/[\\/]/).includes('..')) return false;
  if (process.platform === 'win32' && (/^\\\\[?.]\\/.test(file) || /^[a-z]:[^/\\]/i.test(file) || file.replace(/^[a-z]:/i, '').includes(':'))) return false;
  let target;
  try { target = canonical(path.resolve(input.cwd, file)); }
  catch (e) { if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(e.code)) return false; throw e; }
  return [role.directory, agentboatHome].some(dir => path.isAbsolute(dir) && inside(canonical(dir), target));
}

// Static words and literal quotes only. Shell syntax outside quotes is limited to one input redirect or one pipeline.
function words(command, bash) {
  const tokens = [];
  const word = /(?:'([^'\r\n]*)'|"((?:\$env:AGENTBOAT_HOME|\$AGENTBOAT_HOME)\/memory|[^"\r\n$\x60]*)"|([\p{L}\p{N}_\-./:\\@+=%,]+))/uy;
  if (/[‘’“”\0]/u.test(command)) return;
  let i = 0;
  while (i < command.length) {
    if (/[ \t]/.test(command[i])) { i++; continue; }
    if ('|<&'.includes(command[i])) { tokens.push({ operator: command[i++] }); continue; }
    word.lastIndex = i;
    const match = word.exec(command);
    if (!match || word.lastIndex < command.length && !/[ \t|<&]/.test(command[word.lastIndex])) return;
    if (bash && match[1] === undefined && match[0].includes('\\') || !bash && match[2]?.includes('\x60')) return;
    let value = match[1] ?? match[2] ?? match[3];
    if (match[2]?.startsWith('$')) {
      if (!process.env.AGENTBOAT_HOME || match[2] !== (bash ? '$AGENTBOAT_HOME/memory' : '$env:AGENTBOAT_HOME/memory')) return;
      value = path.join(agentboatHome, 'memory');
    }
    tokens.push({ value, literal: match[1] !== undefined });
    i = word.lastIndex;
  }
  return tokens;
}
const nameOf = value => value?.toLowerCase().replace(/\.exe$/, '');
function isClient(script, cwd, bash) {
  return !!script && same(shellPath(cwd, script, bash), clientPath);
}
function nodeAllowed(args, cwd, bash) {
  const [script, operation] = args;
  if (isClient(script, cwd, bash)) return !!operation && !operation.startsWith('-');
  return !!script && [...rules.scripts].some(([file, operations]) => same(shellPath(cwd, script, bash), file) && operations.has(operation));
}
function readAllowed(name, args) {
  if (!rules.reads.has(name)) return false;
  if (name === 'find') return args.every(arg => !arg.startsWith('-') || rules.find.has(arg));
  if (name === 'rg') return args.every(arg => !/^--(?:pre|hostname-bin|hyperlink-format)(?:=|$)/.test(arg));
  return true;
}
function commandAllowed(input) {
  const bash = input.tool_name !== 'PowerShell', cwd = input.cwd;
  if (typeof input.tool_input?.command !== 'string' || !path.isAbsolute(cwd)) return false;
  const command = input.tool_input.command.trim();
  const here = !bash && /^@'\r?\n([\s\S]*?)\r?\n'@[ \t]*\|[ \t]*([^\r\n]+)$/.exec(command);
  if (here) {
    if (/(?:^|\r?\n)'@/.test(here[1])) return false;
    const next = words(here[2], bash);
    return next?.every(t => !t.operator) && nameOf(next[0]?.value) === 'node' && nodeAllowed(next.slice(1).map(t => t.value), cwd, bash);
  }
  const tokens = words(command, bash);
  if (!tokens?.length) return false;
  if (!bash && tokens[0].operator === '&') tokens.shift();
  const pipe = tokens.findIndex(t => t.operator === '|'), from = tokens.findIndex(t => t.operator === '<');
  if (pipe >= 0 || from >= 0) {
    const target = pipe >= 0 ? tokens.slice(pipe + 1) : tokens.slice(0, from);
    if (target.some(t => t.operator) || nameOf(target[0]?.value) !== 'node' || !nodeAllowed(target.slice(1).map(t => t.value), cwd, bash)) return false;
    if (from >= 0) return bash && pipe < 0 && from === tokens.length - 2 && !!tokens.at(-1).value;
    const source = tokens.slice(0, pipe), [first, ...args] = source.map(t => t.value);
    if (source.some(t => t.operator)) return false;
    return (!bash && source.length === 1 && source[0].literal) ||
      (bash && first === 'printf' && args.length === 2 && args[0] === '%s') || readAllowed(nameOf(first), args);
  }
  if (tokens.some(t => t.operator)) return false;
  const [name, ...args] = tokens.map((t, i) => i === 0 ? nameOf(t.value) : t.value);
  if (name === 'node') return nodeAllowed(args, cwd, bash);
  if (name === 'orca') return rules.orca.has(args[0]) || rules.orca.has(args.slice(0, 2).join(' '));
  if (name !== 'git') return readAllowed(name, args);
  const withDirectory = args[0] === '-C' && !!args[1], op = args[withDirectory ? 2 : 0];
  const rest = args.slice(withDirectory ? 3 : 1);
  if (rest.some(arg => /^--(?:output|ext-diff|textconv|exec|config-env)(?:=|$)/.test(arg))) return false;
  if (rules.gitRead.has(op)) return true;
  const memory = canonical(path.join(agentboatHome, 'memory'));
  const directory = withDirectory ? shellPath(cwd, args[1], bash) : cwd;
  return rules.gitMemory.has(op) && same(canonical(directory), memory) && !rest.includes('--no-index');
}

function context(role) {
  const card = readRoleCard(role.role);
  const name = role.role === 'workspace-main' ? 'agentboat-workspace' : 'orca-project-coordinator';
  return [card, '先读 $' + name + '。', role.summary ? '当前状态（资料）：\n' + role.summary : ''].filter(Boolean).join('\n\n');
}
const workerDone = /^─{4} From: [^\r\n]+ \(worker_done\)\r?$/m;
function toolText(block) {
  return typeof block.content === 'string' ? block.content : (block.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
}
function jsonResult(value) {
  try { return JSON.parse(value.slice(value.indexOf('{'))); } catch { return undefined; }
}
function transcriptTail(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size, buffer = Buffer.alloc(Math.min(size, 8 * 1024 * 1024));
    const length = readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    const lines = buffer.subarray(0, length).toString('utf8').trimEnd().split('\n');
    if (size > buffer.length) lines.shift();
    return lines.filter(Boolean).map(line => JSON.parse(line)).filter(row => !row.isSidechain && !row.isMeta);
  } finally { closeSync(fd); }
}
function unsubmitted(input, role) {
  if (input.stop_hook_active) return false;
  const rows = transcriptTail(input.transcript_path);
  const submits = new Set(), checks = new Set();
  let pending = false;
  for (const row of rows) {
    const content = row.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    if (row.type === 'user' && blocks.some(b => b.type === 'text')) {
      pending = blocks.some(b => b.type === 'text' && workerDone.test(b.text));
      submits.clear(); checks.clear();
    }
    for (const block of blocks) {
      if (row.type === 'assistant' && block.type === 'tool_use' && rules.shells.has(block.name)) {
        const bash = block.name !== 'PowerShell', tokens = words(block.input?.command?.trim() ?? '', bash);
        if (!tokens) continue;
        if (!bash && tokens[0]?.operator === '&') tokens.shift();
        if (tokens.some(t => t.operator)) continue;
        const values = tokens.map(t => t.value), cwd = row.cwd ?? input.cwd;
        if (nameOf(values[0]) === 'node' && isClient(values[1], cwd, bash) && values[2] === 'submit') submits.add(block.id);
        if (nameOf(values[0]) === 'orca' && values[1] === 'orchestration' && ['check', 'inbox'].includes(values[2])) checks.add(block.id);
      } else if (row.type === 'user' && block.type === 'tool_result' && !block.is_error) {
        const body = toolText(block);
        if (checks.has(block.tool_use_id)) {
          const result = jsonResult(body);
          const messages = result?.result?.messages;
          if (workerDone.test(body) || result?.ok && Array.isArray(messages) && messages.some(m => m.type === 'worker_done' && !m.readAt)) pending = true;
        }
        if (submits.has(block.tool_use_id)) {
          const receipt = /^\{"submission":(\{[^\r\n]*?\}),"ok":true[,}]/m.exec(body)?.[1];
          const submission = receipt && JSON.parse(receipt);
          if (submission?.projectId === role.projectId && (submission.phase === 'completed' || submission.phase === 'ready' && submission.pendingAcceptance)) pending = false;
        }
      }
    }
  }
  return pending;
}
function run() {
  const id = process.env.ORCA_AGENT_SESSION_ID;
  if (!id || !/^claude_[\w-]+$/.test(id)) return;
  const data = JSON.parse(readFileSync(roleRegistryPath(), 'utf8'));
  if (data?.version !== 1 || !data.sessions || typeof data.sessions !== 'object' || Array.isArray(data.sessions)) throw Error('角色表格式不正确');
  const role = data.sessions['orca_session_id:' + id];
  if (!role) return;
  if (!(role.role === 'workspace-main' && typeof role.directory === 'string' && path.isAbsolute(role.directory)) &&
    !(role.role === 'project-lead' && typeof role.projectId === 'string' && role.projectId)) throw Error('角色表条目格式不正确');
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (input.agent_id) return;
  if (input.hook_event_name === 'SessionStart')
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context(role) } };
  if (input.hook_event_name === 'Stop' && role.role === 'project-lead' && unsubmitted(input, role))
    return { decision: 'block', reason: stopReason };
  if (input.hook_event_name !== 'PreToolUse' || role.role !== 'workspace-main') return;
  const denied = rules.writes.has(input.tool_name) ? !writeAllowed(input, role) : rules.shells.has(input.tool_name) && !commandAllowed(input);
  if (denied) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: redirect } };
}

try { const result = run(); if (result) process.stdout.write(JSON.stringify(result) + '\n'); }
catch (e) { diagnostic(e); }
