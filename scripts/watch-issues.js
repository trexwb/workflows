#!/usr/bin/env node
/**
 * GitHub Issues 监听器 —— 发现新 Issue 自动触发修复循环流水线（便携版）
 *
 * 用法：
 *   node scripts/watch-issues.js --once                    # 单轮检查（配合系统定时任务）
 *   node scripts/watch-issues.js                           # 默认常驻监听（每 intervalMs 轮询一次）
 *   node scripts/watch-issues.js --owner x --repo y --token $GITHUB_TOKEN --dir /path/to/repo --once
 *   node scripts/watch-issues.js --work-dir /path/to/work --once   # 状态与产物写工作目录
 *
 * 流程：拉取 open issues（按创建时间增量）→ 跳过 PR → 对每个新 issue 调用
 *       run-pipeline.js --pipeline fix 执行修复循环
 *       （01 分析 → 02 方案 → 03 修复 → 04 验证 → 05 PR 描述），
 *       Issue 原文经 --requirement 写入该 issue 专属工作目录（<work-dir>/issue-<N>/），
 *       产物互不覆盖；验证未通过时由编排器按 --fix-rounds 自动回炉重修。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GITHUB_API = 'https://api.github.com';
// 状态文件与流水线产物一律写工作目录，避免污染可能是只读的 skill 安装目录
const STATE_REL = path.join('data', 'processed-issues.json');
let STATE_FILE = path.resolve(process.cwd(), STATE_REL);

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
  if (!cfg.owner || !cfg.repo || !cfg.token || /请填/.test(String(cfg.token))) {
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
      'User-Agent': 'agent-pipeline-watch',
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
function triggerFixPipeline(cfg, issue, workDir) {
  const projectName = `${cfg.owner}/${cfg.repo}`;
  const issueBody = `Issue #${issue.number}：${issue.title}\n\n${(issue.body || '').slice(0, 8000)}\n\n链接：${issue.html_url}`;
  // 每个 issue 一个专属工作目录，产物 artifacts/issue-*.md 与断点续跑状态互不覆盖
  const issueWorkDir = path.join(workDir, `issue-${issue.number}`);
  const args = [
    path.join(ROOT, 'scripts', 'run-pipeline.js'),
    // github.json 配置了非默认流水线配置时沿用其路径，否则用 fix 预设
    ...(cfg.pipelineConfig && cfg.pipelineConfig !== 'config/issue-pipeline.json'
      ? ['--pipeline-config', cfg.pipelineConfig]
      : ['--pipeline', 'fix']),
    '--work-dir', issueWorkDir,
    '--project-name', projectName,
    '--project-dir', cfg.localProjectDir,
    '--requirement', issueBody,
  ];
  if (Number.isFinite(cfg.maxFixRounds) && cfg.maxFixRounds > 0) {
    args.push('--fix-rounds', String(cfg.maxFixRounds));
  }
  console.log(`[watch] Issue #${issue.number} → 触发修复循环（工作目录 ${path.relative(workDir, issueWorkDir) || issueWorkDir}）`);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 0, maxBuffer: 64 * 1024 * 1024 });
  if (result.status === 0) return { status: 'ok' };
  if (result.status === 42) {
    console.error(`[watch] Issue #${issue.number} 等待人工决策：${path.join(issueWorkDir, 'artifacts', 'pm-escalation.json')}`);
    return { status: 'awaiting-human' };
  }
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
  const workDir = path.resolve(args['work-dir'] || process.cwd());
  STATE_FILE = path.join(workDir, STATE_REL);

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
        const r = triggerFixPipeline(cfg, issue, workDir);
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
