#!/usr/bin/env node
/**
 * GitHub Issues 监听器 - 发现新 Issue 自动触发修复循环编排
 *
 * 用法：
 *   # 单轮检查（配合 Windows 计划任务定时调用）
 *   node scripts/watch-issues.js --once
 *
 *   # 常驻监听（默认，每 intervalMs 轮询一次）
 *   node scripts/watch-issues.js --daemon
 *
 *   # 覆盖配置
 *   node scripts/watch-issues.js --owner xxx --repo yyy --token $env:GITHUB_TOKEN --dir D:\code\repo --once
 *
 * 流程：拉取 open issues（按创建时间增量）→ 跳过 PR → 对每个新 issue 调用
 *       run-pipeline.js --pipeline-config config/issue-pipeline.json 执行修复循环
 *       （01 分析 → 02 方案 → 03 修复 → 04 验证 → 05 PR 描述）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GITHUB_API = 'https://api.github.com';
const STATE_FILE = path.join(ROOT, 'data', 'processed-issues.json');

// ---------- 参数与配置 ----------
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
      else { args[key] = true; }
    }
  }
  return args;
}

function loadConfig(args) {
  const fileCfg = fs.existsSync(path.join(ROOT, 'config', 'github.json'))
    ? JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'github.json'), 'utf8'))
    : {};
  const cfg = Object.assign({}, fileCfg, {
    owner: args['owner'] || fileCfg.owner,
    repo: args['repo'] || fileCfg.repo,
    token: args['token'] || process.env.GITHUB_TOKEN || fileCfg.token,
    localProjectDir: args['dir'] || fileCfg.localProjectDir,
    intervalMs: parseInt(args['interval-ms'] || fileCfg.intervalMs || 300000, 10),
    pipelineConfig: args['pipeline-config'] || fileCfg.pipelineConfig || 'config/issue-pipeline.json',
    processExisting: args['process-existing'] ? true : !!fileCfg.processExisting,
    maxFixRounds: parseInt(args['max-fix-rounds'] || fileCfg.maxFixRounds || 2, 10),
  });
  if (!cfg.owner || !cfg.repo || !cfg.token) {
    console.error('错误：缺少 owner / repo / token。请在 config/github.json 填写，或设置环境变量 GITHUB_TOKEN。');
    process.exit(1);
  }
  if (!cfg.localProjectDir || !fs.existsSync(cfg.localProjectDir)) {
    console.error(`错误：本地项目目录不存在：${cfg.localProjectDir}`);
    process.exit(1);
  }
  return cfg;
}

// ---------- 状态管理 ----------
function readState() {
  if (!fs.existsSync(STATE_FILE)) return { lastChecked: null, processed: {} };
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}
function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- GitHub API ----------
async function fetchOpenIssues(cfg) {
  const url = `${GITHUB_API}/repos/${cfg.owner}/${cfg.repo}/issues?state=open&sort=created&direction=asc&per_page=100`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'marvis-workflows',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`GitHub API 错误 ${res.status}: ${text.slice(0, 500)}`);
    return [];
  }
  const items = await res.json();
  // 过滤 PR（GitHub 的 issues 接口会混入 pull_request 条目）
  return items.filter((it) => !it.pull_request);
}

// ---------- 触发修复循环 ----------
function triggerFixPipeline(cfg, issue) {
  const projectName = `${cfg.owner}/${cfg.repo}`;
  const issueBody = `Issue #${issue.number}：${issue.title}\n\n${(issue.body || '').slice(0, 8000)}\n\n链接：${issue.html_url}`;
  const cmd = process.execPath;
  const args = [
    path.join(ROOT, 'scripts', 'run-pipeline.js'),
    '--pipeline-config', cfg.pipelineConfig,
    '--project-name', projectName,
    '--project-dir', cfg.localProjectDir,
    '--from', '01-issue-analysis',
    '--to', '05-pr-summary',
    '--amend', issueBody,
  ];
  console.log(`[watch] Issue #${issue.number} → 触发修复循环`);
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 0, maxBuffer: 64 * 1024 * 1024 });
  if (result.status === 0) return { status: 'ok' };
  console.error(`[watch] Issue #${issue.number} 处理失败：exit=${result.status}`);
  if (result.stderr) console.error((result.stderr || '').slice(-2000));
  if (result.stdout) console.error('日志尾部：' + (result.stdout || '').slice(-2000));
  return { status: 'failed' };
}

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(args);
  const once = !!args['once'];
  const daemon = !!args['daemon'];

  const state = readState();
  if (!state.lastChecked) {
    // 首次运行：建立基线，不处理历史存量，避免积压触发
    const existing = await fetchOpenIssues(cfg);
    existing.forEach((it) => { state.processed[it.number] = { at: it.created_at, status: 'baseline' }; });
    state.lastChecked = new Date().toISOString();
    writeState(state);
    console.log(`[watch] 首次运行，建立基线：已登记 ${existing.length} 个存量 open issue，不处理。`);
    if (once) return;
  }

  for (;;) {
    const issues = await fetchOpenIssues(cfg);
    const cutoff = state.lastChecked || '1970-01-01T00:00:00Z';
    const fresh = issues.filter((it) => it.created_at > cutoff && !state.processed[it.number]);
    console.log(`[watch] 轮询完成：open issues=${issues.length}，新 issue=${fresh.length}`);

    for (const issue of fresh) {
      if (cfg.processExisting) {
        const r = triggerFixPipeline(cfg, issue);
        state.processed[issue.number] = { at: issue.created_at, status: r.status, ts: new Date().toISOString() };
      } else {
        console.log(`[watch] Issue #${issue.number} 为存量，跳过（--process-existing 可处理）`);
        state.processed[issue.number] = { at: issue.created_at, status: 'skipped-existing', ts: new Date().toISOString() };
      }
    }
    state.lastChecked = new Date().toISOString();
    writeState(state);

    if (once) break;
    await new Promise((r) => setTimeout(r, cfg.intervalMs));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
