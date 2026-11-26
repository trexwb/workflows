#!/usr/bin/env node
/**
 * 版本号管理核心 —— 单一权威来源 + 派生位置同步 + 变更日志 + 已安装副本盘点
 *
 * 权威来源：meta.json 的 version 字段（Marvis 必需文件，JSON 便于脚本读写）。
 * 派生位置：SKILL.md frontmatter / SKILL.md 版本章节 / README.md 当前版本 /
 *           安装时生成的 _skillhub_meta.json 与 metadata.json。
 *
 * 零 npm 依赖，Node >= 18。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { SKILL_NAME, userTargets, projectTargets } = require('./platforms');

const VERSION_FILE = 'meta.json';
const CHANGELOG_FILE = 'CHANGELOG.md';
const NOTES_START = '<!-- NOTES:START -->';
const NOTES_END = '<!-- NOTES:END -->';
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

// ---------- 版本读取与计算 ----------
function readVersion(root) {
  const p = path.join(root, VERSION_FILE);
  if (!fs.existsSync(p)) throw new Error('缺少权威版本文件：' + p);
  let meta;
  try { meta = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error('解析 ' + VERSION_FILE + ' 失败：' + e.message); }
  if (!SEMVER_RE.test(meta.version || '')) {
    throw new Error(VERSION_FILE + ' 的 version 必须是 x.y.z 语义化版本，当前值：' + meta.version);
  }
  return meta.version;
}

function parse(v) {
  const m = SEMVER_RE.exec(v || '');
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

function compare(a, b) {
  const x = parse(a); const y = parse(b);
  if (!x || !y) return NaN;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
  }
  return 0;
}

/** level: patch | minor | major | 显式 x.y.z */
function nextVersion(current, level) {
  const c = parse(current);
  if (!c) throw new Error('当前版本非法：' + current);
  if (SEMVER_RE.test(level)) return level;
  if (level === 'major') return `${c.major + 1}.0.0`;
  if (level === 'minor') return `${c.major}.${c.minor + 1}.0`;
  if (level === 'patch') return `${c.major}.${c.minor}.${c.patch + 1}`;
  throw new Error('版本增量只能是 patch / minor / major / 显式 x.y.z，收到：' + level);
}

// ---------- 派生位置 ----------
// 每项 read 返回实际版本号（找不到返回 null），write 返回替换后的文本
const DERIVED = [
  {
    file: 'SKILL.md', label: 'SKILL.md frontmatter',
    read: (t) => { const m = t.match(/^version:\s*(\d+\.\d+\.\d+)\s*$/m); return m ? m[1] : null; },
    write: (t, v) => t.replace(/^(version:\s*)(\d+\.\d+\.\d+)(\s*)$/m, (_, a, __, c) => a + v + c),
  },
  {
    file: 'SKILL.md', label: 'SKILL.md 版本章节',
    read: (t) => { const m = t.match(/## 版本\s*\r?\n\s*(\d+\.\d+\.\d+)/); return m ? m[1] : null; },
    write: (t, v) => t.replace(/(## 版本\s*\r?\n\s*)(\d+\.\d+\.\d+)/, (_, a) => a + v),
  },
  {
    file: 'README.md', label: 'README.md 当前版本',
    read: (t) => { const m = t.match(/当前版本：\*\*(\d+\.\d+\.\d+)\*\*/); return m ? m[1] : null; },
    write: (t, v) => t.replace(/(当前版本：\*\*)(\d+\.\d+\.\d+)(\*\*)/, (_, a, __, c) => a + v + c),
  },
];

function collect(root) {
  const expected = readVersion(root);
  const cache = {};
  const entries = DERIVED.map((d) => {
    const p = path.join(root, d.file);
    const text = cache[d.file] || (fs.existsSync(p) ? (cache[d.file] = fs.readFileSync(p, 'utf8')) : '');
    const actual = d.read(text);
    return { label: d.label, file: d.file, expected, actual, ok: actual === expected };
  });
  return { expected, entries, consistent: entries.every((e) => e.ok) };
}

function sync(root, version, dryRun) {
  const v = version || readVersion(root);
  const changed = [];
  const cache = {};
  for (const d of DERIVED) {
    const p = path.join(root, d.file);
    if (!fs.existsSync(p)) throw new Error('派生文件不存在：' + p);
    const text = cache[d.file] || (cache[d.file] = fs.readFileSync(p, 'utf8'));
    const next = d.write(text, v);
    cache[d.file] = next;
    if (next !== text) changed.push(d.label);
  }
  if (!dryRun) {
    for (const [file, text] of Object.entries(cache)) {
      fs.writeFileSync(path.join(root, file), text);
    }
  }
  return { version: v, changed, dryRun: !!dryRun };
}

// ---------- CHANGELOG：使用中问题的记录与归档 ----------
function changelogPath(root) { return path.join(root, CHANGELOG_FILE); }

function readNotes(root) {
  const p = changelogPath(root);
  if (!fs.existsSync(p)) throw new Error('缺少 ' + CHANGELOG_FILE);
  const text = fs.readFileSync(p, 'utf8');
  const s = text.indexOf(NOTES_START);
  const e = text.indexOf(NOTES_END);
  if (s === -1 || e === -1 || e < s) throw new Error(CHANGELOG_FILE + ' 缺少 ' + NOTES_START + ' / ' + NOTES_END + ' 标记');
  return text.slice(s + NOTES_START.length, e)
    .split('\n').map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim());
}

function addNote(root, text, dryRun) {
  const note = String(text || '').trim();
  if (!note) throw new Error('note 需要问题文本');
  const p = changelogPath(root);
  const content = fs.readFileSync(p, 'utf8');
  const e = content.indexOf(NOTES_END);
  if (e === -1) throw new Error(CHANGELOG_FILE + ' 缺少 ' + NOTES_END + ' 标记');
  const before = content.slice(0, e).replace(/\s*$/, '');
  const after = content.slice(e);
  const next = before + '\n- ' + note + '\n' + after;
  if (!dryRun) fs.writeFileSync(p, next);
  return note;
}

function releaseBlock(version, opts, notes) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [`## [${version}] - ${date}`, '', '> ' + opts.reason];
  const groups = [['Added', opts.added], ['Changed', opts.changed], ['Fixed', opts.fixed]];
  for (const [title, items] of groups) {
    if (items && items.length) {
      lines.push('', '### ' + title);
      for (const it of items) lines.push('- ' + it);
    }
  }
  if (notes.length) {
    lines.push('', '### 本次归档的待办记录');
    for (const n of notes) lines.push('- ' + n);
  }
  if (!opts.added.length && !opts.changed.length && !opts.fixed.length && !notes.length) {
    lines.push('', '- 常规维护与文档更新');
  }
  return lines.join('\n');
}

function insertRelease(root, version, opts, notes, dryRun) {
  const p = changelogPath(root);
  const content = fs.readFileSync(p, 'utf8');
  const s = content.indexOf(NOTES_START);
  const e = content.indexOf(NOTES_END);
  if (s === -1 || e === -1 || e < s) throw new Error(CHANGELOG_FILE + ' 缺少待办区标记');
  // 清空待办区，保留标记，供下一轮迭代继续记录
  const cleared = content.slice(0, s + NOTES_START.length)
    + '\n<!-- 用 node scripts/version.js note "问题描述" 追加 -->\n' + NOTES_END;
  const rest = content.slice(e + NOTES_END.length).replace(/^[\r\n]+/, '');
  const block = releaseBlock(version, opts, notes);
  const next = cleared + '\n\n' + block + '\n\n' + rest;
  if (!dryRun) fs.writeFileSync(p, next);
  return block;
}

// ---------- 版本线重置 ----------
const HISTORY_HEADING = '## 历史归档（重置前）';
const HISTORY_NOTE = '> 以下条目属于重置前的版本线，仅作追溯，不参与当前版本线；标题已降级以免与当前版本冲突。';

/** 把 Unreleased 之后的所有旧版本段落降级归档，再插入新的起始版本段落。重复 reset 不会产生多个归档标题。 */
function insertReset(root, version, opts, notes, dryRun) {
  const p = changelogPath(root);
  const content = fs.readFileSync(p, 'utf8');
  const s = content.indexOf(NOTES_START);
  const e = content.indexOf(NOTES_END);
  if (s === -1 || e === -1 || e < s) throw new Error(CHANGELOG_FILE + ' 缺少待办区标记');
  const cleared = content.slice(0, s + NOTES_START.length)
    + '\n<!-- 用 node scripts/version.js note "问题描述" 追加 -->\n' + NOTES_END;
  const rest = content.slice(e + NOTES_END.length).replace(/^[\r\n]+/, '');
  const archived = rest
    .split(HISTORY_HEADING).join('')
    .split(HISTORY_NOTE).join('')
    .replace(/^## \[(\d+\.\d+\.\d+)\](.*)$/gm, '### [$1]$2')
    .replace(/^[\r\n]+/, '').trim();
  const block = releaseBlock(version, opts, notes);
  const history = archived
    ? '\n\n' + HISTORY_HEADING + '\n\n' + HISTORY_NOTE + '\n\n' + archived + '\n'
    : '';
  const next = cleared + '\n\n' + block + history;
  if (!dryRun) fs.writeFileSync(p, next);
  return block;
}

/** reset：与 bump 的区别是允许降级、不递增，且把旧版本历史归档到文末。 */
function reset(root, version, opts) {
  const o = Object.assign({ reason: '', added: [], changed: [], fixed: [], 'dry-run': false }, opts || {});
  if (!SEMVER_RE.test(String(version || ''))) throw new Error('reset 需要合法的 x.y.z 版本号');
  if (!String(o.reason).trim()) throw new Error('reset 需要 --reason "<重置原因>"');
  for (const k of ['added', 'changed', 'fixed']) {
    if (!Array.isArray(o[k])) o[k] = o[k] ? [o[k]] : [];
  }
  const current = readVersion(root);
  const notes = readNotes(root);
  if (o['dry-run']) {
    return { current, next: version, notes, dryRun: true, block: releaseBlock(version, o, notes) };
  }
  const p = path.join(root, VERSION_FILE);
  const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
  meta.version = version;
  fs.writeFileSync(p, JSON.stringify(meta, null, 2) + '\n');
  const synced = sync(root, version, false);
  const block = insertReset(root, version, o, notes, false);
  return {
    current, next: version, notes, dryRun: false,
    changed: [VERSION_FILE].concat(synced.changed, [CHANGELOG_FILE]),
    block,
  };
}

// ---------- 完整 bump ----------
function bump(root, level, opts) {
  const o = Object.assign({ reason: '', added: [], changed: [], fixed: [], 'dry-run': false }, opts || {});
  if (!String(o.reason).trim()) throw new Error('bump 需要 --reason "<本次变更摘要>"');
  for (const k of ['added', 'changed', 'fixed']) {
    if (!Array.isArray(o[k])) o[k] = o[k] ? [o[k]] : [];
  }
  const current = readVersion(root);
  const next = nextVersion(current, level);
  if (compare(next, current) <= 0) {
    throw new Error('新版本 ' + next + ' 必须大于当前版本 ' + current);
  }
  const notes = readNotes(root);

  if (o['dry-run']) {
    return {
      current, next, notes, dryRun: true,
      changed: collect(root).entries.filter((e) => !e.ok).map((e) => e.label),
      block: releaseBlock(next, o, notes),
    };
  }

  const p = path.join(root, VERSION_FILE);
  const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
  meta.version = next;
  fs.writeFileSync(p, JSON.stringify(meta, null, 2) + '\n');

  const synced = sync(root, next, false);
  const block = insertRelease(root, next, o, notes, false);
  return {
    current, next, notes, dryRun: false,
    changed: [VERSION_FILE].concat(synced.changed, [CHANGELOG_FILE]),
    block,
  };
}

// ---------- 已安装副本版本盘点 ----------
function readInstalledVersion(dir) {
  for (const f of ['meta.json', '_skillhub_meta.json', 'metadata.json']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    try {
      const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
      if (v && SEMVER_RE.test(v)) return { version: v, source: f };
    } catch (e) { /* 尝试下一份元数据 */ }
  }
  const skill = path.join(dir, 'SKILL.md');
  if (fs.existsSync(skill)) {
    const m = fs.readFileSync(skill, 'utf8').match(/^version:\s*(\d+\.\d+\.\d+)\s*$/m);
    if (m) return { version: m[1], source: 'SKILL.md' };
  }
  return { version: null, source: null };
}

function listInstalled(root, home, projectRoot) {
  const expected = readVersion(root);
  const h = home || os.homedir();
  const targets = userTargets(h).concat(projectTargets(projectRoot || process.cwd()));
  const installed = [];
  for (const t of targets) {
    if (!fs.existsSync(t.dir)) continue;
    const skill = path.join(t.dir, 'SKILL.md');
    if (!fs.existsSync(skill)) continue;
    if (!/^name:\s*agent-pipeline\s*$/m.test(fs.readFileSync(skill, 'utf8'))) continue;
    const v = readInstalledVersion(t.dir);
    let status = 'unknown';
    if (v.version) {
      const c = compare(v.version, expected);
      status = c === 0 ? 'current' : (c < 0 ? 'outdated' : 'newer');
    }
    installed.push(Object.assign({}, t, {
      version: v.version, source: v.source, status,
      isLink: (() => { try { return fs.lstatSync(t.dir).isSymbolicLink(); } catch (e) { return false; } })(),
    }));
  }
  return { expected, installed };
}

module.exports = {
  VERSION_FILE, CHANGELOG_FILE, SEMVER_RE, SKILL_NAME,
  readVersion, parse, compare, nextVersion,
  collect, sync, readNotes, addNote, insertRelease, releaseBlock, bump, reset, insertReset,
  readInstalledVersion, listInstalled,
};
