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
  filters: new Set(['select-string', 'select-object', 'convertfrom-json', 'findstr']),
  jqFlags: new Set(['-c', '--compact-output', '-r', '--raw-output', '-s', '--slurp', '-e', '--exit-status']),
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
const questionReason = '有执行者的问题需要主人处理：请先用 submit 登记受阻或待决定，写清主人要做什么，或回复原问题。';
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
  return writablePath(input.cwd, file, [role.directory, agentboatHome]);
}
function writablePath(cwd, file, roots) {
  if (typeof file !== 'string' || !file || typeof cwd !== 'string' || !path.isAbsolute(cwd) || file.split(/[\\/]/).includes('..')) return false;
  if (process.platform === 'win32' && (/^\\\\[?.]\\/.test(file) || /^[a-z]:[^/\\]/i.test(file) || file.replace(/^[a-z]:/i, '').includes(':'))) return false;
  let target;
  try { target = canonical(path.resolve(cwd, file)); }
  catch (e) { if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(e.code)) return false; throw e; }
  return roots.some(dir => typeof dir === 'string' && path.isAbsolute(dir) && inside(canonical(dir), target));
}

function words(command, bash) {
  const tokens = [];
  const word = bash
    ? /(?:'([^']*)'|"((?:\$(?:AGENTBOAT_HOME|TMPDIR|TEMP|TMP)(?=\/)|\\[^\r\n]|[^"\\$\x60])*)"|([\p{L}\p{N}_\-./:@+=%,]+))/uy
    : /(?:'((?:''|[^'‘’])*)'|"((?:\$env:(?:AGENTBOAT_HOME|TMPDIR|TEMP|TMP)(?=[/\\])|\x60["$\x60]|[^"“”$\x60])*)"|([\p{L}\p{N}_\-./:\\@+=%,]+))/uy;
  if (command.includes('\0')) return;
  let i = 0;
  while (i < command.length) {
    if (/[ \t]/.test(command[i])) { i++; continue; }
    if ('|<>&'.includes(command[i])) {
      const operator = command[i] === '>' && command[i + 1] === '>' ? '>>' : command[i];
      tokens.push({ operator }); i += operator.length; continue;
    }
    word.lastIndex = i;
    const match = word.exec(command);
    if (!match || word.lastIndex < command.length && !/[ \t|<>&]/.test(command[word.lastIndex])) return;
    if (match[3] && /^\d+$/.test(match[3]) && command[word.lastIndex] === '>') return;
    let value = match[1] ?? match[2] ?? match[3];
    if (match[2] !== undefined) {
      const expand = bash ? /\\(["\\$\x60])|\$(AGENTBOAT_HOME|TMPDIR|TEMP|TMP)(?=\/)/g : /\x60(["$\x60])|\$env:(AGENTBOAT_HOME|TMPDIR|TEMP|TMP)(?=[/\\])/g;
      const previous = tokens.at(-1);
      if ([...match[2].matchAll(expand)].some(([, , name]) => name) && previous?.value !== '-C' &&
        !['>', '>>'].includes(previous?.operator)) return;
      value = match[2].replace(expand, (_, literal, name) => literal ?? (process.env[name] || ''));
    }
    else if (!bash && match[1] !== undefined) value = match[1].replaceAll("''", "'");
    tokens.push({ value, literal: match[1] !== undefined });
    i = word.lastIndex;
  }
  return tokens;
}
const nameOf = value => value?.toLowerCase().replace(/\.exe$/, '');
function nodeAllowed(args, cwd, bash) {
  const [script, operation] = args;
  if (!script) return false;
  const file = shellPath(cwd, script, bash);
  if (same(file, clientPath)) return !!operation && !operation.startsWith('-');
  return [...rules.scripts].some(([entry, operations]) => same(file, entry) && operations.has(operation));
}
function readAllowed(name, args) {
  if (!rules.reads.has(name)) return false;
  if (name === 'find') return args.every(arg => !arg.startsWith('-') || rules.find.has(arg));
  if (name === 'rg') return args.every(arg => !/^--(?:pre|hostname-bin|hyperlink-format)(?:=|$)/.test(arg));
  return true;
}
function commandAllowed(input, role) {
  const bash = input.tool_name !== 'PowerShell', cwd = input.cwd;
  if (typeof input.tool_input?.command !== 'string' || !path.isAbsolute(cwd)) return false;
  const command = input.tool_input.command.trim();
  const here = !bash && /^@'\r?\n([\s\S]*?)\r?\n'@[ \t]*\|[ \t]*([^\r\n]+)$/.exec(command);
  if (here && /(?:^|\r?\n)'@/.test(here[1])) return false;
  const tokens = words(here ? here[2] : command, bash);
  if (!tokens?.length) return false;
  if (here) tokens.unshift({ value: here[1], literal: true }, { operator: '|' });
  if (!bash && tokens[0].operator === '&') tokens.shift();
  const output = tokens.findIndex(t => t.operator === '>' || t.operator === '>>');
  if (output >= 0) {
    const filename = tokens[output + 1]?.value;
    if (output !== tokens.length - 2 || !filename || /[*?\[\]\r\n]/.test(filename) || !writablePath(cwd, bash && process.platform === 'win32' && /^\/[a-z]\//i.test(filename) ? shellPath(cwd, filename, true) : filename,
      [role.directory, agentboatHome, os.tmpdir(), input.scratchpad_dir, process.env.CLAUDE_CODE_TMPDIR])) return false;
    tokens.splice(output);
  }
  const stages = [[]];
  for (const token of tokens) {
    if (token.operator === '|') stages.push([]);
    else stages.at(-1).push(token);
  }
  if (stages.some(stage => !stage.length)) return false;
  const from = stages[0].findIndex(t => t.operator === '<');
  if (from >= 0) {
    const stage = stages[0];
    if (!bash || from !== stage.length - 2 || !stage.at(-1).value || nameOf(stage[0].value) !== 'node') return false;
    stage.splice(from);
  }
  if (stages.some(stage => stage.some(t => t.operator))) return false;
  const [[first, ...args], ...filters] = stages.map(stage => stage.map(t => t.value));
  const name = nameOf(first);
  const nodeInput = filters.length && nameOf(filters[0][0]) === 'node' && nodeAllowed(filters[0].slice(1), cwd, bash);
  if (nodeInput) {
    if (output >= 0 || from >= 0 || !((!bash && args.length === 0 && stages[0][0].literal) ||
      (bash && first === 'printf' && args.length === 2 && args[0] === '%s') || readAllowed(name, args))) return false;
    filters.shift();
  } else if (!primaryAllowed(name, args, cwd, bash)) return false;
  return filters.every(([filter, ...params]) => {
    const name = nameOf(filter);
    if (rules.filters.has(name) || ['head', 'tail', 'grep', 'rg'].includes(name) && readAllowed(name, params)) return true;
    if (name !== 'jq') return false;
    const expression = params.at(-1);
    return !!expression && !expression.startsWith('-') && params.slice(0, -1).every(flag => rules.jqFlags.has(flag)) &&
      !/\b(?:system|include|import|module)\b/.test(expression.replace(/"(?:\\.|[^"\\])*"/g, ''));
  });
}
function primaryAllowed(name, args, cwd, bash) {
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
const workerDone = /^─{4} From: [^\r\n]+ \(worker_done\)(?: ─{4})?\r?$/m;
const isMail = /^─{4} From: [^\r\n]+ \([a-z_]+\)(?: ─{4})?\r?$/m;
const ownerAction = /主人|用户|人工|本人|手动|登录|验证码|扫码|到场|授权|\b(?:owner|human|sign[ -]?in|log[ -]?in|mfa|2fa)\b/i;
function receivedQuestions(text, check = false) {
  const envelope = /^─{4} From: [^\r\n]+ \(question\)(?: ─{4})?\r?\n([\s\S]*?)^\[Reply: orca orchestration reply --id (msg_[\w-]+)[^\r\n]*\]\r?$/gm;
  const delivered = /^\s*(msg_[\w-]+) question from [^\r\n]+\r?\n([\s\S]*?)^\s*Reply: orca orchestration reply --id \1\b/gm;
  return [...text.matchAll(check ? delivered : envelope)].flatMap(([, a, b]) => ownerAction.test(check ? b : a) ? [check ? a : b] : []);
}
function replyTarget(args) {
  let id;
  for (let i = 0; i < args.length; i++) {
    const [flag, ...value] = args[i].split('=');
    if (['--json', '--full'].includes(flag)) continue;
    if (!['--id', '--body', '--from', '--run', '--on', '--environment', '--pairing-code', '--request-id'].includes(flag)) return;
    const arg = value.length ? value.join('=') : args[++i];
    if (flag === '--id') id = arg;
  }
  return /^msg_[\w-]+$/.test(id ?? '') ? id : undefined;
}
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
    return lines.filter(Boolean).map(line => JSON.parse(line)).filter(row => !row.isSidechain);
  } finally { closeSync(fd); }
}
function stopBlocker(input, role) {
  if (input.stop_hook_active) return;
  const rows = transcriptTail(input.transcript_path);
  const shells = new Set(), checks = new Map(), replies = new Map(), questions = new Set();
  const seenDone = new Set();
  let pending = false;
  const markDone = id => { if (id && !seenDone.has(id)) { seenDone.add(id); pending = true; } };
  for (const row of rows) {
    const content = row.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    if (row.type === 'user' || row.type === 'system') for (const block of blocks) if (block.type === 'text' && typeof block.text === 'string') {
      const header = block.text.split(/\r?\n/, 1)[0];
      if (isMail.test(header)) {
        if (workerDone.test(header)) markDone(row.messageId ?? row.message?.id ?? row.uuid);
        for (const id of receivedQuestions(block.text)) questions.add(id);
      } else if (row.type === 'user' && !row.isMeta) questions.clear();
    }
    for (const block of blocks) {
      if (row.type === 'assistant' && block.type === 'tool_use' && rules.shells.has(block.name)) {
        shells.add(block.id);
        const bash = block.name !== 'PowerShell', tokens = words(block.input?.command?.trim() ?? '', bash);
        if (!tokens) continue;
        if (!bash && tokens[0]?.operator === '&') tokens.shift();
        if (tokens.some(t => t.operator)) continue;
        const values = tokens.map(t => t.value);
        if (nameOf(values[0]) === 'orca' && values[1] === 'orchestration') {
          if (['check', 'inbox'].includes(values[2])) checks.set(block.id, values[2]);
          if (values[2] === 'reply') {
            const id = replyTarget(values.slice(3));
            if (id) replies.set(block.id, id);
          }
        }
      } else if (block.type === 'tool_result' && shells.has(block.tool_use_id) && (row.type === 'user' || row.type === 'system')) {
        const body = toolText(block);
        if (!block.is_error && checks.has(block.tool_use_id)) {
          const result = jsonResult(body);
          const messages = result?.result?.messages;
          const check = checks.get(block.tool_use_id) === 'check';
          if (result?.ok && Array.isArray(messages)) {
            for (const m of messages) if (m.type === 'worker_done' && (check || (!m.handled && !m.read))) markDone(m.id);
          } else {
            for (const [, id, flags] of body.matchAll(/^(msg_[\w-]+) worker_done from ([^\r\n]+)$/gm))
              if (check || flags.includes('[unhandled]')) markDone(id);
            if (check && workerDone.test(body)) markDone(row.uuid ?? block.tool_use_id);
          }
          if (check) {
            for (const id of receivedQuestions(body, true)) questions.add(id);
            if (result?.ok && Array.isArray(messages)) for (const m of messages)
              if (m.type === 'question' && /^msg_[\w-]+$/.test(m.id ?? '') && typeof m.body === 'string' && ownerAction.test(m.body)) questions.add(m.id);
          }
        }
        if (!block.is_error && replies.has(block.tool_use_id)) {
          const result = jsonResult(body);
          const id = result?.result?.messageId ?? result?.result?.message?.id;
          if (result?.ok && /^msg_[\w-]+$/.test(id ?? '') || /^(?:Replied msg_[\w-]+\s*$|.*\bmessageId=msg_[\w-]+\s*$)/m.test(body))
            questions.delete(replies.get(block.tool_use_id));
        }
        for (const [, receipt] of body.matchAll(/\{"submission":(\{[^\r\n]*?\}),"ok":true[,}]/g)) {
          const submission = jsonResult(receipt);
          if (submission?.projectId !== role.projectId || typeof submission.requestId !== 'string') continue;
          pending = false;
          if (submission.phase === 'blocked' || submission.pendingDecision) questions.clear();
        }
      }
    }
  }
  return questions.size ? questionReason : pending ? stopReason : undefined;
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
  if (input.hook_event_name === 'Stop' && role.role === 'project-lead') {
    const reason = stopBlocker(input, role);
    if (reason) return { decision: 'block', reason };
  }
  if (input.hook_event_name !== 'PreToolUse' || role.role !== 'workspace-main') return;
  const denied = rules.writes.has(input.tool_name) ? !writeAllowed(input, role) : rules.shells.has(input.tool_name) && !commandAllowed(input, role);
  if (denied) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: redirect } };
}

try { const result = run(); if (result) process.stdout.write(JSON.stringify(result) + '\n'); }
catch (e) { diagnostic(e); }
