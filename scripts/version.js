#!/usr/bin/env node
/**
 * 版本号管理 CLI —— 记录使用中问题、修复后发版、校验一致性、盘点已安装副本
 *
 * 用法：
 *   node scripts/version.js                              # 版本总览
 *   node scripts/version.js check                       # 校验所有版本位置一致（不一致 exit 1）
 *   node scripts/version.js sync [--dry-run]            # 把派生位置同步到权威版本
 *   node scripts/version.js note "使用中发现的问题"      # 追加到 CHANGELOG 的 Unreleased 待办区
 *   node scripts/version.js bump patch --reason "摘要" --fixed "修复项" [--dry-run]
 *   node scripts/version.js bump minor --reason "摘要" --added "新增项"
 *   node scripts/version.js bump major --reason "摘要"   # 破坏性变更
 *   node scripts/version.js reset 1.0.0 --reason "重置版本线"  # 重置版本线（允许降级，归档旧历史）
 *   node scripts/version.js installed [--project-root <dir>]  # 各宿主已安装版本与升级提示
 *   node scripts/version.js log                         # 查看完整 CHANGELOG
 *   node scripts/version.js help
 *
 * 迭代闭环：note（记录问题）→ 修复代码 → bump（发版 + 归档）→ check → installed → install --force
 */
'use strict';

const fs = require('fs');
const path = require('path');
const V = require('./lib/version');

const ROOT = path.resolve(__dirname, '..');
const ICON = { ok: 'OK', bad: '不一致', outdated: '需升级', current: '一致', newer: '更新', unknown: '未知版本' };

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    let val = true;
    if (next !== undefined && !next.startsWith('--')) { val = next; i++; }
    if (args[key] === undefined) args[key] = val;
    else if (Array.isArray(args[key])) args[key].push(val);
    else args[key] = [args[key], val];
  }
  return args;
}

function asArray(v) {
  if (v === undefined || v === true) return [];
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [v];
}

function help() {
  console.log(`agent-pipeline 版本号管理（权威来源：meta.json 的 version）

用法：node scripts/version.js <命令> [选项]

命令：
  status / 无参数              显示当前版本、各位置一致性、已安装副本概览
  check                       校验一致性；不一致时 exit 1（适合提交前 / CI）
  sync [--dry-run]            把 SKILL.md / README.md 的派生版本同步到权威版本
  note "<问题描述>"            记录使用中发现的问题到 CHANGELOG 的 Unreleased 待办区
  bump <level> --reason "<摘要>" [--added "..."] [--changed "..."] [--fixed "..."] [--dry-run]
                              level = patch | minor | major | 显式 x.y.z
  reset <x.y.z> --reason "<原因>" [--dry-run]
                              重置版本线：允许降级，旧版本段落归档到 CHANGELOG 文末
  installed [--project-root <dir>] [--home <dir>]
                             盘点五宿主已安装副本的版本，列出需要升级的目标
  log                         打印 CHANGELOG.md
  help                        显示本帮助

版本号规则（SemVer）：
  patch  使用中发现的问题修复、文档错字、提示词措辞修正，不改变用法
  minor  新增向后兼容能力：新脚本、新阶段、新宿主、新配置项、新文档
  major  破坏性变更：参数/目录/产物路径重命名、移除适配器、frontmatter 必填字段变化

迭代闭环：
  1. note "在 XX 平台发现 ..."       把问题记进 Unreleased
  2. 修复代码 / 文档 / 配置
  3. bump patch --reason "修复 ..." --fixed "..."   发版并归档问题
  4. check && installed             确认一致性、找出旧副本
  5. install.js --force            升级各宿主副本（部分宿主需重启或 /skills reload）`);
}

function printConsistency(result) {
  console.log('版本一致性（权威：meta.json）：');
  for (const e of result.entries) {
    console.log('  ' + (e.ok ? '[' + ICON.ok + ']    ' : '[' + ICON.bad + ']')
      + ' ' + e.label.padEnd(26) + ' 期望 ' + e.expected + ' / 实际 ' + (e.actual || '未找到'));
  }
}

function status(args) {
  const v = V.readVersion(ROOT);
  console.log('当前版本：' + v + '   权威文件：' + V.VERSION_FILE);
  const c = V.collect(ROOT);
  printConsistency(c);
  console.log('结论：' + (c.consistent ? '全部一致' : '存在不一致，运行 node scripts/version.js sync'));

  const notes = V.readNotes(ROOT);
  console.log('\nUnreleased 待办问题：' + notes.length + ' 条');
  for (const n of notes) console.log('  - ' + n);

  const ins = V.listInstalled(ROOT, args.home, args['project-root']);
  const outdated = ins.installed.filter((i) => i.status === 'outdated');
  console.log('\n已安装副本：' + ins.installed.length + ' 处，其中需升级 ' + outdated.length + ' 处'
    + '（详细：node scripts/version.js installed）');
  return 0;
}

function check() {
  const c = V.collect(ROOT);
  printConsistency(c);
  if (!c.consistent) {
    console.error('\n版本不一致：请先运行 node scripts/version.js sync，或确认是否有手工改动。');
    return 1;
  }
  console.log('\n校验通过：所有位置均为 ' + c.expected);
  return 0;
}

function sync(args) {
  const r = V.sync(ROOT, null, !!args['dry-run']);
  console.log((r.dryRun ? '[演练] ' : '') + '同步到 ' + r.version);
  if (!r.changed.length) console.log('  所有派生位置已是最新版本，无改动。');
  else for (const c of r.changed) console.log('  更新 ' + c);
  return 0;
}

function note(args) {
  const text = args._.slice(1).join(' ').trim() || String(args.note === true ? '' : args.note || '').trim();
  if (!text) { console.error('用法：node scripts/version.js note "使用中发现的问题"'); return 1; }
  const n = V.addNote(ROOT, text, !!args['dry-run']);
  console.log((args['dry-run'] ? '[演练] 将记录：' : '已记录待办：') + n);
  return 0;
}

function bump(args) {
  const level = args._[1];
  if (!level) { console.error('用法：node scripts/version.js bump <patch|minor|major|x.y.z> --reason "<摘要>"'); return 1; }
  const opts = {
    reason: String(args.reason === true ? '' : args.reason || '').trim(),
    added: asArray(args.added), changed: asArray(args.changed), fixed: asArray(args.fixed),
    'dry-run': !!args['dry-run'],
  };
  const r = V.bump(ROOT, level, opts);
  console.log((r.dryRun ? '[演练] ' : '') + '版本 ' + r.current + ' → ' + r.next);
  console.log('归档待办问题 ' + r.notes.length + ' 条');
  if (r.dryRun) console.log('\n将写入 CHANGELOG：\n' + r.block);
  else {
    console.log('已更新：' + r.changed.join('、'));
    console.log('\n下一步：');
    console.log('  node scripts/version.js check && node scripts/version.js installed');
    console.log('  node scripts/install.js --platform auto --scope user --force');
  }
  return 0;
}

function reset(args) {
  const version = args._[1];
  if (!version) { console.error('用法：node scripts/version.js reset <x.y.z> --reason "<原因>"'); return 1; }
  const opts = {
    reason: String(args.reason === true ? '' : args.reason || '').trim(),
    added: asArray(args.added), changed: asArray(args.changed), fixed: asArray(args.fixed),
    'dry-run': !!args['dry-run'],
  };
  const r = V.reset(ROOT, version, opts);
  console.log((r.dryRun ? '[演练] ' : '') + '版本线重置：' + r.current + ' → ' + r.next);
  console.log('归档待办问题 ' + r.notes.length + ' 条');
  if (r.dryRun) console.log('\n将写入 CHANGELOG：\n' + r.block);
  else {
    console.log('已更新：' + r.changed.join('、'));
    console.log('旧版本段落已移入 CHANGELOG.md 的「历史归档（重置前）」区，未丢弃。');
    console.log('\n下一步：node scripts/version.js check && node scripts/version.js installed');
    console.log('若各宿主装有旧版本线副本，用 node scripts/install.js --force 覆盖；'
      + 'installed 可能显示为「更新」，属重置后的预期情况。');
  }
  return 0;
}

function installed(args) {
  const r = V.listInstalled(ROOT, args.home, args['project-root']);
  console.log('源码版本：' + r.expected);
  if (!r.installed.length) {
    console.log('未发现已安装副本。可用 node scripts/install.js --dry-run 查看安装位置。');
    return 0;
  }
  console.log('\n宿主 / 范围'.padEnd(38) + '版本'.padEnd(12) + '状态      来源');
  for (const i of r.installed) {
    const label = (i.label.split('（')[0] + ' / ' + i.scope).padEnd(36);
    console.log(label + String(i.version || '-').padEnd(12) + (ICON[i.status] || i.status).padEnd(10)
      + (i.source || '-') + (i.isLink ? '（软链）' : ''));
  }
  const outdated = r.installed.filter((i) => i.status === 'outdated');
  if (outdated.length) {
    console.log('\n以下 ' + outdated.length + ' 处仍为旧版本：');
    for (const i of outdated) console.log('  - ' + i.label + ' / ' + i.scope + ' → ' + i.dir + ' [' + i.version + ']');
    console.log('\n升级：node scripts/install.js --platform <宿主> --scope <user|project> --force');
    console.log('（软链安装会自动跟随源码版本，无需升级）');
    return 2;
  }
  console.log('\n所有副本均与源码版本一致。');
  return 0;
}

function log() {
  const p = path.join(ROOT, V.CHANGELOG_FILE);
  if (!fs.existsSync(p)) { console.error('缺少 ' + V.CHANGELOG_FILE); return 1; }
  console.log(fs.readFileSync(p, 'utf8'));
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'status';
  switch (cmd) {
    case 'status': return status(args);
    case 'check': return check();
    case 'sync': return sync(args);
    case 'note': return note(args);
    case 'bump': return bump(args);
    case 'reset': return reset(args);
    case 'installed': return installed(args);
    case 'log': return log();
    case 'help': case '--help': case '-h': help(); return 0;
    default:
      console.error('未知命令：' + cmd + '\n');
      help();
      return 1;
  }
}

try {
  process.exit(main());
} catch (e) {
  console.error('[版本管理] 错误：' + e.message);
  process.exit(1);
}
