import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { applySetup, previewSetup, refreshInstalledSkills, skillTargets, validateCodexHome } from './install.mjs';
import { installationRoot } from '../coordinator/scripts/orca-cli.mjs';

const options = (home, codexHome = path.join(home, '.codex')) => ({ home, env: { ...process.env, CODEX_HOME: codexHome } });
function install(home, codexHome, preview = previewSetup, apply = applySetup) {
  const config = options(home, codexHome);
  const plan = preview(config);
  if (plan.error) throw Error(plan.error);
  return apply(plan.confirmation, config);
}

function refreshFixture(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'agentboat-refresh-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const codex = path.join(home, 'custom-codex');
  install(home, codex);
  const repository = installationRoot().replaceAll('\\', '/'), skills = skillTargets(home);
  rmSync(path.join(home, '.agentboat/backups'), { recursive: true });
  return { home, codex, repository, skills, refresh: () => refreshInstalledSkills(repository, home, codex),
    backups: path.join(home, '.agentboat/backups') };
}

test('refresh backs up both changed trees, retains links and leaves a matching installation untouched', t => {
  const { refresh, backups, home, codex, skills } = refreshFixture(t);
  const files = [path.join(skills[0].installed, 'SKILL.md'), path.join(skills[1].installed, 'references/bridge.md')];
  const contents = files.map(file => readFileSync(file, 'utf8'));
  const hooks = [path.join(home, '.claude/settings.json'), path.join(codex, 'hooks.json')];
  const snapshot = () => [...hooks, ...skills.map(s => s.claudeLink)].map(file => fs.lstatSync(file).mtimeMs);
  const before = snapshot();
  assert.equal(refresh(), false);
  assert.ok(!fs.existsSync(backups));
  files.forEach((file, i) => writeFileSync(file, contents[i] + '\nold'));
  const extra = path.join(skills[1].installed, 'obsolete.md');
  writeFileSync(extra, 'obsolete');
  assert.equal(refresh(), false);
  assert.deepEqual(files.map(file => readFileSync(file, 'utf8')), contents);
  const [backup] = readdirSync(backups);
  assert.match(backup, /^skill-refresh-/);
  files.forEach((file, i) => {
    const archived = path.join(backups, backup, path.basename(skills[i].installed), path.relative(skills[i].installed, file));
    assert.equal(readFileSync(archived, 'utf8'), contents[i] + '\nold');
    assert.equal(realpathSync(skills[i].claudeLink), realpathSync(skills[i].installed));
  });
  assert.equal(fs.existsSync(extra), false);
  assert.equal(readFileSync(path.join(backups, backup, 'orca-project-coordinator/obsolete.md'), 'utf8'), 'obsolete');
  const times = files.map(file => fs.statSync(file).mtimeMs);
  assert.equal(refresh(), false);
  assert.deepEqual(files.map(file => fs.statSync(file).mtimeMs), times);
  assert.deepEqual(readdirSync(backups), [backup]);
  assert.deepEqual(snapshot(), before);
});

test('refresh updates both Antigravity copies and keeps custom files alongside managed files', t => {
  const { refresh, backups, skills } = refreshFixture(t);
  const files = skills.map(s => path.join(s.antigravity, 'SKILL.md'));
  const originals = files.map(file => readFileSync(file, 'utf8'));
  for (const [i, file] of files.entries()) writeFileSync(file, originals[i] + '\nold');
  const custom = path.join(skills[1].antigravity, 'references/personal.md');
  writeFileSync(custom, 'keep');
  assert.equal(refresh(), false);
  assert.deepEqual(files.map(file => readFileSync(file, 'utf8')), originals);
  assert.equal(readFileSync(custom, 'utf8'), 'keep');
  const [backup] = readdirSync(backups);
  for (const [i, file] of files.entries()) {
    const archived = path.join(backups, backup, 'antigravity', path.basename(path.dirname(file)), 'SKILL.md');
    assert.equal(readFileSync(archived, 'utf8'), originals[i] + '\nold');
  }
  assert.equal(refresh(), false);
  assert.deepEqual(readdirSync(backups), [backup]);
});

test('refresh respects a missing setup, removed skills, occupied directories and a different Orca profile', t => {
  const { home, repository, skills, codex, refresh, backups } = refreshFixture(t);
  const empty = path.join(home, 'new-home');
  assert.equal(refreshInstalledSkills(repository, empty, path.join(empty, '.codex')), false);
  assert.ok(!fs.existsSync(empty));
  const second = path.join(home, 'other-profile/agentboat-current');
  cpSync(path.join(repository, 'workspace/harness'), path.join(second, 'workspace/harness'), { recursive: true });
  assert.equal(refreshInstalledSkills(second, home, codex), false);
  rmSync(skills[0].installed, { recursive: true });
  rmSync(skills[0].antigravity, { recursive: true });
  const foreign = path.join(skills[1].installed, 'SKILL.md');
  const foreignAgy = path.join(skills[1].antigravity, 'SKILL.md');
  writeFileSync(foreign, '---\nname: other-skill\n---');
  writeFileSync(foreignAgy, '---\nname: orca-project-coordinator\n---\nPersonal skill');
  assert.equal(refresh(), false);
  assert.ok(!fs.existsSync(skills[0].installed));
  assert.ok(!fs.existsSync(skills[0].antigravity));
  assert.equal(readFileSync(foreign, 'utf8'), '---\nname: other-skill\n---');
  assert.equal(readFileSync(foreignAgy, 'utf8'), '---\nname: orca-project-coordinator\n---\nPersonal skill');
  symlinkSync(skills[1].installed, skills[0].installed, process.platform === 'win32' ? 'junction' : 'dir');
  refresh();
  assert.ok(fs.lstatSync(skills[0].installed).isSymbolicLink());
  assert.ok(!fs.existsSync(backups));
});

test('a failed swap rolls back and startup reclaims an exited process lock to restore the interrupted skill', t => {
  const { home, refresh, skills } = refreshFixture(t);
  const target = skills[0].installed, file = path.join(target, 'SKILL.md'), current = readFileSync(file, 'utf8');
  writeFileSync(file, current + '\nold');
  const rename = fs.renameSync, log = t.mock.method(console, 'error', () => {});
  const failSwap = t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(from) === 'next' && to === target) throw Error('simulated swap failure');
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try { refresh(); } finally { failSwap.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(log.mock.calls.length, 1);
  assert.equal(readFileSync(file, 'utf8'), current + '\nold');
  const stage = mkdtempSync(path.join(path.dirname(target), '.agentboat-workspace-refresh-'));
  cpSync(target, path.join(stage, 'next'), { recursive: true });
  rename(target, path.join(stage, 'old'));
  const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(child.status, 0);
  const lock = path.join(home, '.agentboat-setup.lock');
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'pid-' + child.pid + '-11111111-1111-1111-1111-111111111111'), '');
  refresh();
  assert.equal(readFileSync(file, 'utf8'), current);
  assert.ok(!fs.existsSync(stage));
  assert.ok(!fs.existsSync(lock));
});

test('setup reclaims a reused PID only when the process creation identity differs', t => {
  const { home, codex } = refreshFixture(t);
  const config = options(home, codex), lock = path.join(realpathSync(home), '.agentboat-setup.lock');
  const rename = fs.renameSync;
  let identity;
  const observe = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === lock) identity = readFileSync(path.join(from, readdirSync(from)[0]), 'utf8');
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try { applySetup(undefined, config); }
  finally { observe.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(identity);
  mkdirSync(lock);
  const record = path.join(lock, 'pid-' + process.pid + '-11111111-1111-1111-1111-111111111111');
  for (const sameOrUnknown of [identity, 'invalid identity']) {
    writeFileSync(record, sameOrUnknown);
    assert.throws(() => applySetup(undefined, config), error => error.message.includes('确认持有进程退出') && error.message.includes(lock));
    assert.equal(readFileSync(record, 'utf8'), sameOrUnknown);
  }
  const reused = identity.replace(/\d(?=[^\d]*$)/, digit => digit === '9' ? '8' : '9');
  assert.notEqual(reused, identity);
  writeFileSync(record, reused);
  assert.deepEqual(applySetup(undefined, config).completed, []);
  assert.ok(!fs.existsSync(lock));
});

test('hook drift compares owned events, matchers and commands without writing either config', t => {
  const { refresh, home, codex } = refreshFixture(t);
  for (const file of [path.join(home, '.claude/settings.json'), path.join(codex, 'hooks.json')]) {
    const original = readFileSync(file, 'utf8');
    const settings = JSON.parse(original);
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command: 'foreign' }] });
    writeFileSync(file, JSON.stringify(settings));
    assert.equal(refresh(), false);
    for (const mutate of [
      x => { x.hooks.SessionStart[0].matcher = 'wrong'; },
      x => { x.hooks.Stop[0].hooks[0].timeout = 90; },
      x => { x.hooks.OtherEvent = x.hooks.SessionStart; },
      x => { delete x.hooks.PreToolUse; }
    ]) {
      const changed = structuredClone(settings);
      mutate(changed);
      writeFileSync(file, JSON.stringify(changed));
      assert.equal(refresh(), true);
      assert.equal(readFileSync(file, 'utf8'), JSON.stringify(changed));
    }
    writeFileSync(file, original);
  }
});

test('setup refuses unknown skills and each foreign profile target before any write', t => {
  const { home, codex, repository, skills, backups } = refreshFixture(t);
  const config = options(home, codex), other = path.join(home, 'other-profile/agentboat-current');
  const settings = path.join(home, '.claude/settings.json'), hooks = path.join(codex, 'hooks.json');
  const shared = path.join(skills[1].installed, 'SKILL.md'), agy = path.join(skills[1].antigravity, 'SKILL.md');
  const foreign = path.join(other, 'workspace/harness/hook.mjs');
  const change = [
    [shared, () => 'personal skill'],
    [shared, original => original.replaceAll(repository, other.replaceAll('\\', '/'))],
    [agy, original => original.replaceAll(repository, other.replaceAll('\\', '/'))],
    [settings, original => {
      const config = JSON.parse(original);
      config.hooks.Stop[0].hooks[0].args[0] = foreign;
      return JSON.stringify(config);
    }],
    [hooks, original => {
      const config = JSON.parse(original);
      config.hooks.Stop[0].hooks[0].command = `node "${foreign.replaceAll('\\', '/')}" --agentboat-role-harness --codex`;
      return JSON.stringify(config);
    }]
  ];
  const firstSkill = path.join(skills[0].installed, 'SKILL.md');
  writeFileSync(firstSkill, readFileSync(firstSkill, 'utf8') + '\nold');
  const preview = previewSetup(config);
  assert.ok(preview.confirmation && preview.paths.includes(skills[0].installed));
  for (const [file, replace] of change) {
    const original = readFileSync(file, 'utf8'), foreignContent = replace(original);
    assert.notEqual(foreignContent, original);
    writeFileSync(file, foreignContent);
    const conflict = previewSetup(config);
    assert.ok(conflict.error.includes(file.endsWith('SKILL.md') ? path.dirname(file) : file), conflict.error);
    assert.equal(conflict.confirmation, undefined);
    assert.throws(() => applySetup(preview.confirmation, config), /归属未知|其他 Orca 配置/);
    assert.equal(readFileSync(file, 'utf8'), foreignContent);
    assert.match(readFileSync(firstSkill, 'utf8'), /old$/);
    assert.ok(!fs.existsSync(backups));
    writeFileSync(file, original);
  }
});

test('Node diagnosis and a fresh preview stay read-only', t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'agentboat-preview-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const config = options(home, path.join(home, 'custom-codex'));
  const preview = previewSetup(config);
  assert.equal(preview.paths.length, 9);
  assert.ok(preview.paths.includes(path.join(config.env.CODEX_HOME, 'hooks.json')));
  const withoutPath = Object.fromEntries(Object.entries(config.env).filter(([key]) => !['PATH', 'PROGRAMFILES', 'LOCALAPPDATA'].includes(key.toUpperCase())));
  withoutPath.ProgramFiles = path.join(home, 'program-files');
  withoutPath.LOCALAPPDATA = path.join(home, 'local-app-data');
  const blocked = previewSetup({ home, env: withoutPath });
  assert.match(blocked.error, /独立 Node\.js ≥22.*PATH.*重启 Orca/);
  assert.deepEqual(readdirSync(home), []);
  if (process.platform === 'win32') {
    const nodeDir = path.join(withoutPath.LOCALAPPDATA, 'Programs', 'nodejs');
    mkdirSync(nodeDir, { recursive: true });
    const node = path.join(nodeDir, 'node.exe');
    cpSync(process.execPath, node);
    const pathKey = Object.keys(config.env).find(key => key.toUpperCase() === 'PATH');
    const nodeBin = path.dirname(realpathSync(process.execPath));
    withoutPath.PATH = config.env[pathKey].split(path.delimiter).filter(dir =>
      !fs.existsSync(path.join(dir.replace(/^"(.*)"$/, '$1'), 'node.exe')) && path.relative(nodeBin, dir)).join(path.delimiter);
    const fixture = { home, env: withoutPath };
    const ready = previewSetup(fixture);
    assert.ok(ready.confirmation, ready.error);
    applySetup(ready.confirmation, fixture);
    const definition = JSON.parse(readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
    assert.equal(definition.hooks.Stop[0].hooks[0].command, node);
  }
});

test('custom CODEX_HOME accepts only complete Windows or POSIX paths before preview', t => {
  for (const valid of ['C:\\Codex data', '\\\\host\\share\\codex']) assert.equal(validateCodexHome(valid, 'win32'), valid);
  for (const bad of ['C:codex', '\\codex', '/codex', '\\\\host', 'C:\\one\\..\\two', 'C:/one/./two', 'C:\\control\n']) {
    assert.throws(() => validateCodexHome(bad, 'win32'), /完整绝对路径/);
  }
  for (const bad of ['codex', '~/codex', '/one/../two', '/codex\u0000']) assert.throws(() => validateCodexHome(bad, 'darwin'), /完整绝对路径/);
  assert.equal(validateCodexHome('/Users/test/Codex data', 'darwin'), '/Users/test/Codex data');
  const home = mkdtempSync(path.join(os.tmpdir(), 'agentboat-invalid-codex-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.match(previewSetup({ ...options(home), codexHome: path.join(home, 'codex') + '\u0001' }).error, /控制字符/);
  assert.deepEqual(readdirSync(home), []);
});

test('Claude links are checked against the physical parent and cannot use the nominal home path', t => {
  const { home, skills, codex } = refreshFixture(t);
  const [skill] = skills, physical = path.join(home, 'redirected/.claude/skills');
  const other = path.join(home, 'redirected/.agents/skills', skill.name);
  const parent = path.dirname(skill.claudeLink);
  for (const { claudeLink } of skills) fs.unlinkSync(claudeLink);
  fs.rmdirSync(parent);
  mkdirSync(physical, { recursive: true });
  mkdirSync(other, { recursive: true });
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(physical, parent, kind);
  const relative = path.relative(parent, skill.installed);
  symlinkSync(process.platform === 'win32' ? other : relative, skill.claudeLink, kind);
  // A junction gives the same physical target on Windows without creating a privileged relative symlink.
  const read = fs.readlinkSync;
  const relativeRead = t.mock.method(fs, 'readlinkSync', (file, ...args) => file === skill.claudeLink ? relative : read(file, ...args));
  syncBuiltinESMExports();
  try {
    assert.notEqual(realpathSync(skill.claudeLink), realpathSync(skill.installed));
    assert.ok(previewSetup(options(home, codex)).error.includes(skill.claudeLink));
  } finally { relativeRead.mock.restore(); syncBuiltinESMExports(); }
});

test('setup serializes callers, preserves a last-minute hook edit and retries from its partial receipt', t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'agentboat-setup-race-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const config = options(home), settings = path.join(home, '.claude/settings.json'), hooks = path.join(home, '.codex/hooks.json');
  const personal = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"keep this edit"}]}]}}';
  const initial = '{"model":"fixture"}';
  mkdirSync(path.dirname(hooks), { recursive: true });
  writeFileSync(hooks, initial);
  const stale = previewSetup(config);
  writeFileSync(hooks, personal);
  assert.throws(() => applySetup(stale.confirmation, config), /已更改/);
  assert.ok(!fs.existsSync(path.join(home, '.agents')));
  writeFileSync(hooks, initial);
  const preview = previewSetup(config), rename = fs.renameSync;
  const inject = t.mock.method(fs, 'renameSync', (file, to) => {
    if (file === hooks && path.basename(to) === 'old') {
      assert.throws(() => applySetup(preview.confirmation, config), /另一次 AgentBoat 设置/);
      const update = hooks + '.editor';
      writeFileSync(update, personal);
      rename(update, hooks);
    }
    return rename(file, to);
  });
  syncBuiltinESMExports();
  let backup;
  try {
    assert.throws(() => applySetup(preview.confirmation, config), error => {
      assert.ok(error.message.includes(hooks));
      assert.ok(error.message.includes(settings));
      backup = /备份位置：(.+)$/.exec(error.message)?.[1];
      return !!backup;
    });
  } finally { inject.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(readFileSync(hooks, 'utf8'), personal);
  assert.equal(readFileSync(path.join(backup, '.codex/hooks.json'), 'utf8'), initial);
  const completed = readFileSync(path.join(backup, 'completed.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(completed.length, 8);
  assert.ok(completed.includes(settings));
  const retry = previewSetup(config);
  assert.deepEqual(retry.paths, [hooks]);
  const publish = fs.linkSync;
  const late = t.mock.method(fs, 'linkSync', (file, to) => {
    if (to === hooks && path.basename(file) === 'next') writeFileSync(path.join(path.dirname(file), 'old'), personal + '\n');
    return publish(file, to);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => applySetup(retry.confirmation, config), /写入期间已更改/); }
  finally { late.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(readFileSync(hooks, 'utf8'), personal + '\n');
  const after = applySetup(previewSetup(config).confirmation, config);
  assert.deepEqual(after.completed, [hooks]);
  const receipt = JSON.parse(readFileSync(path.join(after.backup, 'replaced-hooks.jsonl'), 'utf8').trim());
  assert.equal(readFileSync(receipt.replaced, 'utf8'), personal + '\n');
  assert.deepEqual(JSON.parse(readFileSync(hooks, 'utf8')).hooks.Stop[0], JSON.parse(personal).hooks.Stop[0]);
  assert.equal(readFileSync(path.join(backup, '.codex/hooks.json'), 'utf8'), initial);
});

test('preview restores an interrupted hook commit before preparing another confirmation', t => {
  const { home, codex, repository } = refreshFixture(t);
  const hooks = path.join(codex, 'hooks.json'), config = options(home, codex);
  const original = readFileSync(hooks);
  const stage = mkdtempSync(path.join(codex, '.hooks.json-agentboat-'));
  writeFileSync(path.join(stage, 'owner'), JSON.stringify([repository, path.join(realpathSync(codex), 'hooks.json')]));
  writeFileSync(path.join(stage, 'next'), original);
  fs.renameSync(hooks, path.join(stage, 'old'));
  const captured = path.join(stage, 'current');
  writeFileSync(captured, 'editor bytes');
  assert.ok(previewSetup(config).error.includes(captured));
  assert.equal(readFileSync(captured, 'utf8'), 'editor bytes');
  assert.ok(!fs.existsSync(hooks));
  rmSync(captured);
  assert.equal(previewSetup(config).confirmation, undefined);
  assert.deepEqual(readFileSync(hooks), original);
  assert.ok(!fs.existsSync(stage));
});

test('missing live hooks with two valid recovery records require manual selection and preserve both versions', t => {
  const { home, codex, repository } = refreshFixture(t);
  const hooks = path.join(codex, 'hooks.json'), config = options(home, codex);
  const owner = JSON.stringify([repository, path.join(realpathSync(codex), 'hooks.json')]);
  const original = readFileSync(hooks, 'utf8');
  const updated = JSON.stringify({ ...JSON.parse(original), note: 'editor saved newer content' });
  const records = [original, updated].map((bytes, i) => {
    const stage = path.join(codex, '.hooks.json-agentboat-' + (i === 0 ? 'A' : 'B'));
    mkdirSync(stage);
    if (i !== 0) writeFileSync(hooks, bytes);
    const saved = path.join(stage, 'old');
    fs.renameSync(hooks, saved);
    writeFileSync(path.join(stage, 'next'), bytes);
    writeFileSync(path.join(stage, 'owner'), owner);
    return { stage, saved, bytes };
  });
  const check = message => {
    assert.match(message, /多份.*人工核对/);
    assert.ok(message.includes(hooks));
    for (const { saved } of records) assert.ok(message.includes(saved));
    return true;
  };
  const plan = previewSetup(config);
  check(plan.error);
  assert.equal(plan.confirmation, undefined);
  const unowned = path.join(codex, '.hooks.json-agentboat-0-unknown');
  cpSync(records[0].stage, unowned, { recursive: true });
  writeFileSync(path.join(unowned, 'owner'), 'foreign');
  assert.throws(() => applySetup(undefined, config), error => check(error.message));
  assert.ok(!fs.existsSync(hooks));
  for (const { stage, saved, bytes } of records) {
    assert.equal(readFileSync(saved, 'utf8'), bytes);
    assert.equal(readFileSync(path.join(stage, 'next'), 'utf8'), bytes);
    assert.equal(readFileSync(path.join(stage, 'owner'), 'utf8'), owner);
  }
});

test('hooks preflight rejects ENOTSUP before moving the original and keeps a failed rollback recoverable', t => {
  const { home, codex } = refreshFixture(t);
  const hooks = path.join(codex, 'hooks.json'), config = options(home, codex);
  const live = path.join(realpathSync(codex), 'hooks.json');
  const original = JSON.parse(readFileSync(hooks, 'utf8'));
  original.hooks.Stop[0].hooks[0].timeout = 45;
  const bytes = JSON.stringify(original);
  writeFileSync(hooks, bytes);
  const plan = previewSetup(config), link = fs.linkSync;
  let failProbe = true;
  const fail = t.mock.method(fs, 'linkSync', (from, to) => {
    if (failProbe ? path.dirname(to) === path.dirname(live) : to === live)
      throw Object.assign(Error('ENOTSUP: fixture filesystem does not support hard links'), { code: 'ENOTSUP' });
    return link(from, to);
  });
  const stages = () => readdirSync(codex).filter(name => name.startsWith('.hooks.json-agentboat-'));
  syncBuiltinESMExports();
  try {
    assert.throws(() => applySetup(plan.confirmation, config), /原文件保留.*hooks\.json[\s\S]*ENOTSUP/);
    assert.equal(readFileSync(hooks, 'utf8'), bytes);
    assert.deepEqual(stages(), []);
    failProbe = false;
    assert.throws(() => applySetup(plan.confirmation, config), /ENOTSUP[\s\S]*被移走的原内容保存在/);
    assert.ok(!fs.existsSync(hooks));
    const [name] = stages(), stage = path.join(codex, name);
    assert.equal(readFileSync(path.join(stage, 'old'), 'utf8'), bytes);
    assert.ok(fs.existsSync(path.join(stage, 'owner')));
    assert.ok(fs.existsSync(path.join(stage, 'next')));
  } finally { fail.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(previewSetup(config).paths, [hooks]);
  assert.equal(readFileSync(hooks, 'utf8'), bytes);
  assert.deepEqual(stages(), []);
});

test('preview completes interrupted relinking of old hooks after authenticating the owner', t => {
  const { home, codex, repository } = refreshFixture(t);
  const hooks = path.join(codex, 'hooks.json'), config = options(home, codex), original = readFileSync(hooks);
  const stage = mkdtempSync(path.join(codex, '.hooks.json-agentboat-'));
  const old = path.join(stage, 'old'), owner = path.join(stage, 'owner');
  writeFileSync(path.join(stage, 'next'), 'staged replacement');
  writeFileSync(owner, 'foreign');
  fs.renameSync(hooks, old);
  fs.linkSync(old, hooks);
  assert.equal(fs.statSync(hooks).nlink, 2);
  assert.match(previewSetup(config).error, /归属未知/);
  assert.equal(fs.statSync(hooks).nlink, 2);
  writeFileSync(owner, JSON.stringify([repository, path.join(realpathSync(codex), 'hooks.json')]));
  for (let attempt = 0; attempt < 2; attempt++) {
    const plan = previewSetup(config);
    assert.equal(plan.error, undefined);
    assert.equal(plan.confirmation, undefined);
    assert.equal(fs.statSync(hooks).nlink, 1);
    assert.deepEqual(readFileSync(hooks), original);
    assert.ok(!fs.existsSync(stage));
  }
});

test('installer renders both skills in a moved repository, links Claude and copies to Antigravity', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'agentboat-install-'));
  try {
    const alias = path.join(temp, 'linked');
    mkdirSync(path.join(temp, 'original'));
    symlinkSync(path.join(temp, 'original'), alias, process.platform === 'win32' ? 'junction' : 'dir');
    const repo = path.join(alias, '仓库 with spaces'), home = path.join(temp, 'home');
    mkdirSync(path.join(repo, 'workspace'), { recursive: true });
    cpSync(new URL('./install.mjs', import.meta.url), path.join(repo, 'workspace/install.mjs'));
    cpSync(new URL('../coordinator/scripts/orca-cli.mjs', import.meta.url), path.join(repo, 'coordinator/scripts/orca-cli.mjs'));
    cpSync(new URL('./harness', import.meta.url), path.join(repo, 'workspace/harness'), { recursive: true });
    cpSync(new URL('./skill', import.meta.url), path.join(repo, 'workspace/skill'), { recursive: true });
    cpSync(new URL('../coordinator/skill', import.meta.url), path.join(repo, 'coordinator/skill'), { recursive: true });
    const moved = await import(pathToFileURL(path.join(repo, 'workspace/install.mjs')));
    const settingsFile = path.join(home, '.claude/settings.json');
    mkdirSync(path.dirname(settingsFile), { recursive: true });
    const settings = { theme: 'dark', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'ponytail' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'prior-stop' }] }], UserPromptSubmit: [] } };
    const original = JSON.stringify(settings, null, 3);
    writeFileSync(settingsFile, original);
    const codexFile = path.join(home, '.codex/hooks.json'), config = path.join(home, '.codex/config.toml');
    mkdirSync(path.dirname(codexFile), { recursive: true });
    const existing = { description: 'original', hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'orca' }] }],
      PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'remote-hooks' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'ponytail' }] }], Interrupt: []
    } };
    const originalCodex = JSON.stringify(existing, null, 3);
    writeFileSync(codexFile, originalCodex);
    writeFileSync(config, 'model = "fixture"\n[hooks.state]\n');
    const agyFile = path.join(home, '.gemini/config/hooks.json');
    const orcaStatus = { PreInvocation: [{ type: 'command', command: 'orca-status-hook' }] };
    mkdirSync(path.dirname(agyFile), { recursive: true });
    const originalAgy = JSON.stringify({ 'orca-status': orcaStatus });
    writeFileSync(agyFile, originalAgy);
    const originalExec = process.execPath;
    let result;
    try {
      process.execPath = path.join(temp, 'orca-electron.exe');
      result = install(home, undefined, moved.previewSetup, moved.applySetup);
    } finally { process.execPath = originalExec; }
    assert.equal(result.completed.length, 9);
    function check(dir) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, e.name);
        if (e.isDirectory()) check(file);
        else if (file.endsWith('.md')) assert.doesNotMatch(readFileSync(file, 'utf8'), /\{\{AGENTBOAT_REPO\}\}|[DC]:[\\/]AIGroup[\\/]AgentBoat|%APPDATA%/);
      }
    }
    for (const { installed, claudeLink, antigravity } of moved.skillTargets(home)) {
      assert.equal(realpathSync(claudeLink), realpathSync(installed));
      assert.equal(antigravity, path.join(home, '.gemini/config/skills', path.basename(installed)));
      assert.ok(fs.lstatSync(antigravity).isDirectory());
      check(installed);
      check(antigravity);
      for (const file of readdirSync(installed, { recursive: true, withFileTypes: true }).filter(e => e.isFile())) {
        const relative = path.relative(installed, path.join(file.parentPath, file.name));
        assert.deepEqual(readFileSync(path.join(antigravity, relative)), readFileSync(path.join(installed, relative)));
      }
    }
    const renderedRepo = realpathSync(repo).replaceAll('\\', '/');
    assert.ok(readFileSync(path.join(home, '.agents/skills/agentboat-workspace/SKILL.md'), 'utf8').includes(renderedRepo));
    assert.ok(readFileSync(path.join(home, '.agents/skills/orca-project-coordinator/SKILL.md'), 'utf8').includes(renderedRepo));
    const updated = readFileSync(settingsFile, 'utf8'), installed = JSON.parse(updated);
    assert.equal(installed.theme, settings.theme);
    assert.deepEqual(installed.hooks.UserPromptSubmit, []);
    for (const event of ['SessionStart', 'PreToolUse', 'Stop']) {
      assert.deepEqual(installed.hooks[event].slice(0, -1), settings.hooks[event] ?? []);
      const { command, args, onFailure } = installed.hooks[event].at(-1).hooks[0];
      assert.equal(realpathSync(command), realpathSync(originalExec));
      assert.equal(realpathSync(args[0]), realpathSync(path.join(repo, 'workspace/harness/hook.mjs')));
      assert.equal(onFailure, 'continue');
    }
    const codex = readFileSync(codexFile, 'utf8'), codexHooks = JSON.parse(codex);
    assert.equal(codexHooks.description, 'original');
    assert.deepEqual(codexHooks.hooks.Interrupt, []);
    for (const event of ['SessionStart', 'PreToolUse', 'UserPromptSubmit', 'Stop']) {
      assert.deepEqual(codexHooks.hooks[event].slice(0, -1), existing.hooks[event] ?? []);
      assert.match(codexHooks.hooks[event].at(-1).hooks[0].command, /harness\/hook\.mjs['"] --agentboat-role-harness --codex$/);
    }
    const agy = JSON.parse(readFileSync(agyFile, 'utf8'));
    assert.deepEqual(agy['orca-status'], orcaStatus);
    assert.match(agy['agentboat-project-lead'].PreInvocation[0].command, /harness\/hook\.mjs['"] --agentboat-role-harness --antigravity$/);
    const backups = () => readdirSync(path.dirname(result.backup));
    assert.equal(readFileSync(path.join(result.backup, '.codex/hooks.json'), 'utf8'), originalCodex);
    assert.equal(readFileSync(path.join(result.backup, '.claude/settings.json'), 'utf8'), original);
    assert.equal(readFileSync(path.join(result.backup, '.gemini/config/hooks.json'), 'utf8'), originalAgy);
    assert.deepEqual(install(home, undefined, moved.previewSetup, moved.applySetup), { completed: [] });
    assert.equal(readFileSync(settingsFile, 'utf8'), updated);
    assert.equal(readFileSync(codexFile, 'utf8'), codex);
    assert.equal(readFileSync(config, 'utf8'), 'model = "fixture"\n[hooks.state]\n');
    assert.equal(backups().length, 1);
    const foreignHome = path.join(temp, 'foreign-home');
    mkdirSync(path.join(foreignHome, '.claude/skills/orca-project-coordinator'), { recursive: true });
    writeFileSync(path.join(foreignHome, '.claude/skills/orca-project-coordinator/keep'), 'keep');
    assert.throws(() => install(foreignHome), /已有其他内容/);
    assert.equal(readFileSync(path.join(foreignHome, '.claude/skills/orca-project-coordinator/keep'), 'utf8'), 'keep');
    const agyHome = path.join(temp, 'foreign-agy');
    const foreign = path.join(agyHome, '.gemini/config/skills/orca-project-coordinator');
    mkdirSync(foreign, { recursive: true });
    const personal = path.join(foreign, 'SKILL.md');
    writeFileSync(personal, '---\nname: orca-project-coordinator\n---\nPersonal skill');
    assert.throws(() => install(agyHome), /归属未知/);
    assert.equal(readFileSync(personal, 'utf8'), '---\nname: orca-project-coordinator\n---\nPersonal skill');
    assert.equal(fs.existsSync(path.join(agyHome, '.agents')), false);
  } finally {
    assert.equal(path.dirname(temp), os.tmpdir()); assert.match(path.basename(temp), /^agentboat-install-/);
    rmSync(temp, { recursive: true, force: true });
  }
});
