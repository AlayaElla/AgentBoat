import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { install, refreshInstalledSkills } from './install.mjs';

function refreshFixture(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'agentboat-refresh-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const codex = path.join(home, 'custom-codex');
  const { repository, skills } = install(home, codex);
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

test('refresh respects a missing setup, removed skills, occupied directories and a different Orca profile', t => {
  const { home, repository, skills, codex, refresh, backups } = refreshFixture(t);
  const empty = path.join(home, 'new-home');
  assert.equal(refreshInstalledSkills(repository, empty, path.join(empty, '.codex')), false);
  assert.ok(!fs.existsSync(empty));
  const second = path.join(home, 'other-profile/agentboat-current');
  cpSync(path.join(repository, 'workspace/harness'), path.join(second, 'workspace/harness'), { recursive: true });
  assert.equal(refreshInstalledSkills(second, home, codex), false);
  rmSync(skills[0].installed, { recursive: true });
  const foreign = path.join(skills[1].installed, 'SKILL.md');
  writeFileSync(foreign, '---\nname: other-skill\n---');
  assert.equal(refresh(), false);
  assert.ok(!fs.existsSync(skills[0].installed));
  assert.equal(readFileSync(foreign, 'utf8'), '---\nname: other-skill\n---');
  symlinkSync(skills[1].installed, skills[0].installed, process.platform === 'win32' ? 'junction' : 'dir');
  refresh();
  assert.ok(fs.lstatSync(skills[0].installed).isSymbolicLink());
  assert.ok(!fs.existsSync(backups));
});

test('a failed swap rolls back and an interrupted swap recovers on the next startup', t => {
  const { refresh, skills } = refreshFixture(t);
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
  refresh();
  assert.equal(readFileSync(file, 'utf8'), current);
  assert.ok(!fs.existsSync(stage));
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
      x => { x.hooks.Stop[0].hooks[0].command = 'wrong'; },
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

test('installer renders both skills in a moved repository, links Claude and refuses foreign contents before writing', async () => {
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
    const { install } = await import(pathToFileURL(path.join(repo, 'workspace/install.mjs')));
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
    const result = install(home);
    assert.equal(result.skills.length, 2);
    function check(dir) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, e.name);
        if (e.isDirectory()) check(file);
        else if (file.endsWith('.md')) assert.doesNotMatch(readFileSync(file, 'utf8'), /\{\{AGENTBOAT_REPO\}\}|[DC]:[\\/]AIGroup[\\/]AgentBoat|%APPDATA%/);
      }
    }
    for (const s of result.skills) { check(s.installed); assert.equal(realpathSync(s.claudeLink), realpathSync(s.installed)); }
    const renderedRepo = realpathSync(repo).replaceAll('\\', '/');
    assert.ok(readFileSync(path.join(home, '.agents/skills/agentboat-workspace/SKILL.md'), 'utf8').includes(renderedRepo));
    assert.ok(readFileSync(path.join(home, '.agents/skills/orca-project-coordinator/SKILL.md'), 'utf8').includes(renderedRepo));
    const updated = readFileSync(settingsFile, 'utf8'), installed = JSON.parse(updated);
    assert.equal(installed.theme, settings.theme);
    assert.deepEqual(installed.hooks.UserPromptSubmit, []);
    for (const event of ['SessionStart', 'PreToolUse', 'Stop']) {
      assert.deepEqual(installed.hooks[event].slice(0, -1), settings.hooks[event] ?? []);
      const { command, args, onFailure } = installed.hooks[event].at(-1).hooks[0];
      assert.equal(command, process.execPath);
      assert.equal(realpathSync(args[0]), realpathSync(path.join(repo, 'workspace/harness/hook.mjs')));
      assert.equal(onFailure, 'continue');
    }
    const codex = readFileSync(codexFile, 'utf8'), codexHooks = JSON.parse(codex);
    assert.equal(codexHooks.description, 'original');
    assert.deepEqual(codexHooks.hooks.Interrupt, []);
    for (const event of ['SessionStart', 'PreToolUse', 'Stop']) {
      assert.deepEqual(codexHooks.hooks[event].slice(0, -1), existing.hooks[event]);
      assert.match(codexHooks.hooks[event].at(-1).hooks[0].command, /harness\/hook\.mjs['"] --agentboat-role-harness --codex$/);
    }
    const codexBackups = () => readdirSync(path.dirname(codexFile)).filter(name => name.endsWith('.bak'));
    assert.equal(codexBackups().length, 1);
    assert.equal(readFileSync(path.join(path.dirname(codexFile), codexBackups()[0]), 'utf8'), originalCodex);
    const backups = () => readdirSync(path.dirname(settingsFile)).filter(name => name.endsWith('.bak'));
    assert.equal(backups().length, 1);
    assert.equal(readFileSync(path.join(path.dirname(settingsFile), backups()[0]), 'utf8'), original);
    assert.deepEqual(install(home), result);
    assert.equal(readFileSync(settingsFile, 'utf8'), updated);
    assert.equal(readFileSync(codexFile, 'utf8'), codex);
    assert.equal(codexBackups().length, 1);
    assert.equal(readFileSync(config, 'utf8'), 'model = "fixture"\n[hooks.state]\n');
    assert.equal(backups().length, 1);
    const foreignHome = path.join(temp, 'foreign-home');
    mkdirSync(path.join(foreignHome, '.claude/skills/orca-project-coordinator'), { recursive: true });
    writeFileSync(path.join(foreignHome, '.claude/skills/orca-project-coordinator/keep'), 'keep');
    assert.throws(() => install(foreignHome), /已有其他内容/);
    assert.equal(readFileSync(path.join(foreignHome, '.claude/skills/orca-project-coordinator/keep'), 'utf8'), 'keep');
  } finally {
    assert.equal(path.dirname(temp), os.tmpdir()); assert.match(path.basename(temp), /^agentboat-install-/);
    rmSync(temp, { recursive: true, force: true });
  }
});
