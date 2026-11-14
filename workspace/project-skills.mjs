#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const source = '.agents/skills';
const proposals = '.agentboat/skill-proposals';
const reviews = '.agentboat/skill-reviews.json';
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function name(value) {
  if (!namePattern.test(value || '') || value.length > 64 || ['synced', 'anthropic-skills'].includes(value)) throw new Error('skill 名称须为不超过 64 字符的小写字母、数字、连字符，且非保留名');
  return value;
}
function ordinary(file) {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`不接受链接：${file}`);
}
// Walk each existing ancestor before any read/write, including junctions on Windows.
function location(root, relative) {
  ordinary(root);
  let file = root;
  for (const part of relative.split('/')) {
    file = path.join(file, part);
    if (fs.existsSync(file)) ordinary(file);
    else { try { fs.lstatSync(file); throw new Error(`断开的链接：${file}`); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  }
  return file;
}
export function filesAt(directory, prefix = '') {
  ordinary(directory);
  const files = {};
  for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const file = path.join(directory, item.name), key = prefix + item.name;
    ordinary(file);
    if (item.isDirectory()) Object.assign(files, filesAt(file, `${key}/`));
    else if (item.isFile()) files[key] = fs.readFileSync(file);
    else throw new Error(`不是普通文件：${file}`);
  }
  return files;
}
export function digest(files) {
  const hash = createHash('sha256');
  for (const key of Object.keys(files).sort()) hash.update(key).update('\0').update(files[key]).update('\0');
  return hash.digest('hex');
}
export function validate(directory) {
  const files = filesAt(directory);
  const text = files['SKILL.md']?.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = text?.match(/^---\n([\s\S]*?)\n---\n([\s\S]+)$/);
  if (!match || !match[2].trim() || /\bTODO\b|\[填写/.test(text)) throw new Error(`SKILL.md 缺少 frontmatter、正文或仍有占位：${directory}`);
  // shortcut: the portable profile accepts only two single-line YAML strings; use JSON quotes for punctuation.
  const metadata = {};
  for (const line of match[1].split('\n')) {
    const field = line.match(/^(name|description): (.+)$/);
    if (!field || metadata[field[1]]) throw new Error('frontmatter 仅允许唯一的 name 和 description，值为单行字符串');
    const value = field[2].startsWith('"') ? JSON.parse(field[2]) : field[2];
    if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f<>]/.test(value) || (!field[2].startsWith('"') && /[:#\[\]{}'"&*!|>@`]/.test(value))) throw new Error('frontmatter 字符串无效；请用 JSON 双引号字符串');
    metadata[field[1]] = value;
  }
  name(metadata.name);
  if (metadata.name !== path.basename(directory) || !metadata.description || metadata.description.length > 1024) throw new Error('name 须与目录一致，description 须为 1–1024 字符');
  return { ...metadata, sha256: digest(files), files: Object.keys(files) };
}
function record(root) {
  const file = location(root, reviews);
  const value = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('skill 审核记录无效');
  return value;
}
function writeTree(directory, files) {
  for (const [key, value] of Object.entries(files)) {
    const file = path.join(directory, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value, { flag: 'wx' });
  }
}
export function initialize(root) {
  root = path.resolve(root);
  for (const relative of [source, proposals]) fs.mkdirSync(location(root, relative), { recursive: true });
  const keep = location(root, `${source}/.gitkeep`);
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, '', { flag: 'wx' });
  const attributes = location(root, `${source}/.gitattributes`);
  if (!fs.existsSync(attributes)) fs.writeFileSync(attributes, '* -text\n', { flag: 'wx' });
  return { source, proposals };
}
export function create(root, id, description) {
  name(id);
  if (!description?.trim()) throw new Error('需要 description，说明何时使用');
  const directory = location(path.resolve(root), `${proposals}/${id}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${id}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${id}\n\n[填写可复用步骤、适用范围、验证方式；不要包含凭据或本机绝对路径]\n`, { flag: 'wx' });
  return { directory };
}
export function list(root) {
  root = path.resolve(root);
  const records = record(root);
  return [source, proposals].flatMap(base => {
    const directory = location(root, base);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).filter(item => !item.name.startsWith('.')).map(item => {
      const skill = validate(location(root, `${base}/${item.name}`));
      const approved = records[skill.name]?.sha256 === skill.sha256;
      return { ...skill, status: base === proposals ? 'proposal' : approved ? 'approved' : 'unreviewed' };
    });
  });
}
export function publish(root, id, reviewer, evidence) {
  root = path.resolve(root); name(id);
  if (!reviewer?.trim() || !evidence?.trim()) throw new Error('发布需要项目主 agent 的 reviewer 与审核依据 source');
  const draft = location(root, `${proposals}/${id}`), canonical = location(root, `${source}/${id}`), mirror = location(root, `.claude/skills/${id}`);
  const skill = validate(draft), records = record(root), previous = records[id];
  // Check both destinations before replacing either; never overwrite foreign or edited files.
  for (const destination of [canonical, mirror]) if (fs.existsSync(destination) && (!previous || digest(filesAt(destination)) !== previous.sha256)) throw new Error(`目标有未审核或自行修改的内容，未覆盖：${destination}`);
  const files = filesAt(draft);
  // Keep reviewed bytes unchanged when Windows Git checks out a new worktree.
  initialize(root);
  const attributes = location(root, '.claude/skills/.gitattributes');
  fs.mkdirSync(path.dirname(attributes), { recursive: true });
  if (!fs.existsSync(attributes)) fs.writeFileSync(attributes, '* -text\n', { flag: 'wx' });
  for (const destination of [canonical, mirror]) {
    if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true });
    writeTree(destination, files);
  }
  records[id] = { reviewer, source: evidence, sha256: skill.sha256 };
  const file = location(root, reviews);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(records, null, 2) + '\n');
  return { name: id, ...records[id], mergeRequired: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values, positionals: [command] } = parseArgs({ allowPositionals: true, options: Object.fromEntries(['root', 'name', 'description', 'path', 'reviewer', 'source'].map(k => [k, { type: 'string' }])) });
    const root = values.root || process.cwd();
    let result;
    if (command === 'init') result = initialize(root);
    else if (command === 'new') result = create(root, values.name, values.description);
    else if (command === 'validate') result = values.path ? validate(path.resolve(values.path)) : list(root);
    else if (command === 'list') result = list(root);
    else if (command === 'publish') result = publish(root, values.name, values.reviewer, values.source);
    else throw new Error('用法：project-skills.mjs init|new|validate|list|publish --root <项目>；new 需 --name --description；publish 需 --name --reviewer --source');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
