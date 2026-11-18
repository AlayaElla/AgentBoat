import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initialize, create, validate, publish, list, digest } from './project-skills.mjs';

const sandbox = path.resolve(process.env.AGENTBOAT_SANDBOX || path.join(os.tmpdir(), 'agentboat-sandbox'));
test('提议不进入发现目录；审核后发布同内容副本；更新保护外来文件和已编辑副本', t => {
  fs.mkdirSync(sandbox, { recursive: true });
  const root = fs.mkdtempSync(path.join(sandbox, 'agentboat-demo-skills-unit-'));
  const draft = path.join(root, '.agentboat/skill-proposals/demo-check');
  try {
    initialize(root); initialize(root);
    create(root, 'demo-check', '在检查 demo 时使用');
    assert.throws(() => validate(draft), /占位/);
    fs.writeFileSync(path.join(draft, 'SKILL.md'), '---\nname: demo-check\ndescription: "在检查 demo 时使用"\n---\n\n回复 DEMO_OK。\n');
    fs.mkdirSync(path.join(draft, 'references'));
    fs.writeFileSync(path.join(draft, 'references/check.md'), '检查正文');
    fs.writeFileSync(path.join(root, '.agents/skills/notes.txt'), 'not a skill');
    assert.equal(list(root)[0].status, 'proposal');
    assert.equal(fs.existsSync(path.join(root, '.claude')), false);
    assert.throws(() => publish(root, 'demo-check'), /reviewer/);
    const draftFile = path.join(draft, 'SKILL.md'), read = fs.readFileSync; let draftReads = 0;
    const observer = t.mock.method(fs, 'readFileSync', (file, ...args) => { if (file === draftFile) draftReads++; return read(file, ...args); });
    fs.writeFileSync(path.join(draft, '__proto__'), '附件');
    publish(root, 'demo-check', '项目主 agent', '测试审核记录');
    observer.mock.restore(); assert.equal(draftReads, 1);
    assert.equal(fs.readFileSync(path.join(root, '.claude/skills/demo-check/__proto__'), 'utf8'), '附件');
    assert.equal(list(root).find(s => s.status === 'approved').name, 'demo-check');
    assert.deepEqual(fs.readFileSync(path.join(root, '.agents/skills/demo-check/references/check.md')), fs.readFileSync(path.join(root, '.claude/skills/demo-check/references/check.md')));
    const mirror = path.join(root, '.claude/skills/demo-check/SKILL.md');
    fs.appendFileSync(mirror, '用户修改');
    assert.throws(() => publish(root, 'demo-check', 'main', 'test'), /未覆盖/);
    assert.match(fs.readFileSync(mirror, 'utf8'), /用户修改/);
    for (const id of ['../escape', 'UPPER', 'synced', 'x'.repeat(65)]) assert.throws(() => create(root, id, 'test'));
    fs.writeFileSync(path.join(draft, 'SKILL.md'), '---\nname: demo-check\nname: demo-check\ndescription: demo\n---\nBody');
    assert.throws(() => validate(draft), /唯一/);
    fs.unlinkSync(mirror);
    fs.symlinkSync(draft, path.join(root, '.agents/skills/foreign'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => list(root), /链接/);
    assert.throws(() => create(root, 'demo-check', 'test'), /EEXIST/);
  } finally {
    assert.equal(path.dirname(root), sandbox);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('skill digest has a fixed UTF-8 LF contract shared with hands', () => {
  assert.equal(digest({ 'SKILL.md': Buffer.from('---\nname: demo-check\ndescription: "在检查 demo 时使用"\n---\n\n回复 DEMO_OK。\n'), 'references/check.md': Buffer.from('检查正文') }), 'd3bc45171dec7cd7bb88f2d02f2738735cd501f0ae62e71d356e8d1a5f0baa94');
});
