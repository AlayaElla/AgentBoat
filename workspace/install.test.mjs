import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, readdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

test('installer renders both skills in a moved repository, links Claude and refuses foreign contents before writing', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'agentboat-install-'));
  try {
    const repo = path.join(temp, '仓库 with spaces'), home = path.join(temp, 'home');
    mkdirSync(path.join(repo, 'workspace'), { recursive: true });
    cpSync(new URL('./install.mjs', import.meta.url), path.join(repo, 'workspace/install.mjs'));
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
    assert.ok(readFileSync(path.join(home, '.agents/skills/agentboat-workspace/SKILL.md'), 'utf8').includes(repo.replaceAll('\\', '/')));
    assert.ok(readFileSync(path.join(home, '.agents/skills/orca-project-coordinator/references/bridge.md'), 'utf8').includes(repo.replaceAll('\\', '/')));
    const updated = readFileSync(settingsFile, 'utf8'), installed = JSON.parse(updated);
    assert.equal(installed.theme, settings.theme);
    assert.deepEqual(installed.hooks.UserPromptSubmit, []);
    for (const event of ['SessionStart', 'PreToolUse', 'Stop']) {
      assert.deepEqual(installed.hooks[event].slice(0, -1), settings.hooks[event] ?? []);
      const { command, args, onFailure } = installed.hooks[event].at(-1).hooks[0];
      assert.equal(command, process.execPath);
      assert.equal(args[0], path.join(repo, 'workspace/harness/hook.mjs'));
      assert.equal(onFailure, 'continue');
    }
    const backups = () => readdirSync(path.dirname(settingsFile)).filter(name => name.endsWith('.bak'));
    assert.equal(backups().length, 1);
    assert.equal(readFileSync(path.join(path.dirname(settingsFile), backups()[0]), 'utf8'), original);
    assert.deepEqual(install(home), result);
    assert.equal(readFileSync(settingsFile, 'utf8'), updated);
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
