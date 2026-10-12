#!/usr/bin/env node
/**
 * init-project.js —— 流程前置：拉取项目代码（便携版，跨平台，零依赖）
 *
 * 用法:
 *   node scripts/init-project.js --url <git地址> --name <项目名> [--branch <分支名>] [--dry-run]
 *   node scripts/init-project.js --url <git地址> --dir <目标目录> [--branch <分支名>] [--dry-run]
 *
 * 行为:
 *   - 目标目录缺省 = <root>/<项目名>；--root 缺省为当前目录（无平台硬编码）
 *   - --name 缺省时取 git 地址末尾仓库名作为项目名
 *   - --branch 缺省时，git ls-remote --heads 优先 DEV 系分支（DEV/dev/develop），否则取第 1 位远程分支
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const url = arg('url', '');
const name = arg('name', '');
const root = arg('root', process.cwd());
let dir = arg('dir', '');
if (!dir) {
  const repoName = name || (url.split('/').pop() || '').replace(/\.git\s*$/i, '');
  if (!repoName) {
    console.error('错误：无法从 --url 推断项目名，请提供 --name');
    process.exit(1);
  }
  dir = path.join(root, repoName);
}
let branch = arg('branch', '');
const dryRun = process.argv.includes('--dry-run');

if (!url) {
  console.error('用法: node scripts/init-project.js --url <git地址> [--name <项目名>] [--branch <分支名>] [--dry-run]');
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  if (dryRun) {
    console.log('[dry-run]', cmd, args.join(' '));
    return { status: 0, stdout: '' };
  }
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    console.error(`[git] ${cmd} 失败:\n${r.stderr || r.stdout}`);
    process.exit(r.status || 1);
  }
  return r;
}

// 1. 解析分支：未指定时优先 DEV 系分支，其次取第 1 位远程分支
if (!branch) {
  const ls = run('git', ['ls-remote', '--heads', url]);
  const heads = ls.stdout
    .split('\n')
    .map((l) => l.match(/refs\/heads\/(.+)$/))
    .filter(Boolean)
    .map((m) => m[1]);
  if (heads.length === 0) {
    console.error(`[git] ${url} 上没有可用的远程分支`);
    process.exit(1);
  }
  const preferred = ['DEV', 'dev', 'develop'];
  branch = preferred.find((b) => heads.includes(b)) || heads[0];
  console.log(`[git] 未指定分支，优先 DEV 系分支: ${branch}${!preferred.includes(branch) ? '（仓库无 DEV/dev/develop，已回退第 1 位分支）' : ''}`);
} else {
  console.log(`[git] 指定分支: ${branch}`);
}

// 2. 判断目标目录状态：已有仓库则 fetch+checkout，否则 clone
const absDir = path.resolve(dir);
const isRepo = fs.existsSync(path.join(absDir, '.git'));

if (isRepo) {
  console.log(`[git] ${absDir} 已是 git 仓库，执行 fetch + checkout ${branch}`);
  run('git', ['fetch', 'origin', branch], { cwd: absDir });
  run('git', ['checkout', branch], { cwd: absDir });
} else {
  if (fs.existsSync(absDir) && fs.readdirSync(absDir).length > 0) {
    console.error(`[git] ${absDir} 已存在且非空，请更换目录或清理后重试`);
    process.exit(1);
  }
  fs.mkdirSync(absDir, { recursive: true });
  console.log(`[git] 执行 clone -b ${branch} --single-branch ${url} -> ${absDir}`);
  run('git', ['clone', '-b', branch, '--single-branch', url, absDir]);
}

console.log(`[ok] 项目已就绪: ${absDir} @ ${branch}`);
