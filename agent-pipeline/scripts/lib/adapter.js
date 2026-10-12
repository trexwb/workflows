#!/usr/bin/env node
/**
 * CLI 适配层 —— 让流水线编排器运行在任意 agent CLI 之上（零 npm 依赖，Node >= 16）
 *
 * 内置适配器：
 *   codebuddy  CodeBuddy Code CLI（原生 --agent/--agents 多代理、--fallback-model 回退）
 *   claude     Claude Code CLI（--append-system-prompt 注入角色系统提示词）
 *   codex      OpenAI Codex CLI（codex exec 非交互，角色提示词拼入任务头部）
 *   plain      任意自定义命令（config/cli.json 的 plain.command，提示词走参数或 stdin）
 *
 * 选择顺序：环境变量 AGENT_PIPELINE_ADAPTER > cli.json adapter > autoDetect 依次探测。
 * 统一接口：
 *   runner.name / label() / probe() / run(opts) / extraModels() / supportsFallbackFlag
 *   run(opts)：opts = { prompt, agentId, agentDef, agentsJson, model, fallbackModel,
 *                      cwd, timeoutMs, permissions, outputFormat }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

// ---------- 默认配置 ----------
const DEFAULTS = {
  adapter: 'auto',
  autoDetect: ['codebuddy', 'cbc', 'claude', 'codex'],
  timeoutMs: 600000,
  permissions: 'skip',
  outputFormat: 'text',
  plain: { command: '', promptMode: 'arg', extraArgs: [] },
};

function loadCliConfig(root, cliConfigPath, overrides) {
  let fileCfg = {};
  const p = cliConfigPath || path.join(root, 'config', 'cli.json');
  try {
    fileCfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { /* 配置缺失/损坏时使用默认值 */ }
  // 过滤 undefined，避免覆盖文件配置中的有效值
  const ov = {};
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v !== undefined && v !== null) ov[k] = v;
  }
  const cfg = Object.assign({}, DEFAULTS, fileCfg, ov);
  cfg.plain = Object.assign({}, DEFAULTS.plain, fileCfg.plain || {}, ov.plain || {});
  return cfg;
}

// ---------- 跨平台探测与执行 ----------
function which(bin) {
  try {
    const probe = process.platform === 'win32'
      ? spawnSync('where', [bin], { encoding: 'utf8' })
      : spawnSync('which', [bin], { encoding: 'utf8' });
    return probe.status === 0 && (probe.stdout || '').trim().length > 0;
  } catch (e) { return false; }
}

// Windows：npm 全局包的 .cmd 包装器不能被 spawn 直接执行，改为用 node 直跑 JS 入口
function resolveNodeEntry(pkgName, binNames) {
  if (process.platform !== 'win32') return null;
  try {
    const globalRoot = execSync('npm root -g', {
      encoding: 'utf8',
      shell: process.env.ComSpec || 'cmd.exe',
    }).trim();
    const pkgDir = path.join(globalRoot, pkgName);
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const bin = typeof pkg.bin === 'string'
      ? pkg.bin
      : (pkg.bin && binNames.map((b) => pkg.bin[b]).find(Boolean));
    const entry = bin ? path.join(pkgDir, bin) : '';
    if (entry && fs.existsSync(entry)) return { node: process.execPath, entry };
  } catch (e) { /* 忽略，回退 .cmd */ }
  return null;
}

function shellQuote(a) {
  return /[\s"^&|<>%]/.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a;
}

// 统一执行入口：binSpec 为字符串命令或 { node, entry }（Windows node 直跑）
function spawnCli(binSpec, args, opts) {
  const base = {
    encoding: 'utf8',
    timeout: (opts && opts.timeoutMs) || 0,
    maxBuffer: 64 * 1024 * 1024,
    cwd: opts && opts.cwd,
    input: opts && opts.input,
  };
  if (typeof binSpec === 'object' && binSpec.node) {
    return spawnSync(binSpec.node, [binSpec.entry].concat(args), base);
  }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binSpec)) {
    const line = [binSpec].concat(args).map(shellQuote).join(' ');
    return spawnSync(line, Object.assign({}, base, { shell: true }));
  }
  return spawnSync(binSpec, args, base);
}

// ---------- 限额/过载错误判定（命中则触发模型自动切换） ----------
function isQuotaError(text) {
  return /quota|rate\s*limit|429|insufficient|overload|limit\s*exceeded|过载|限额|超限|额度不足/i.test(text || '');
}

// ---------- CodeBuddy 专属：~/.codebuddy/models.json 自定义模型（完整 ID custom-local:<id>） ----------
function loadCodebuddyCustomModels() {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const p = path.join(home, '.codebuddy', 'models.json');
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (data.models || []).map((m) => (m.id && m.id.startsWith('custom-local:') ? m.id : 'custom-local:' + m.id));
  } catch (e) { return []; }
}

// ---------- 适配器解析 ----------
function resolveAdapterName(cfg) {
  const name = process.env.AGENT_PIPELINE_ADAPTER || cfg.adapter;
  if (name && name !== 'auto') return name;
  const list = cfg.autoDetect || DEFAULTS.autoDetect;
  for (const cand of list) {
    if (cand === 'codebuddy' || cand === 'cbc') {
      if (process.env.CODE_BUDDY_CMD || which('codebuddy') || which('cbc')) return 'codebuddy';
    } else if (which(cand)) {
      return cand;
    }
  }
  return null;
}

// 角色提示词头部（无原生角色机制的适配器使用）
function roleHeader(agentDef) {
  return agentDef && agentDef.prompt
    ? `# 角色设定\n${agentDef.prompt}\n\n# 任务\n`
    : '';
}

// ---------- 各适配器 ----------
function codebuddyRunner() {
  function bin() {
    const envCmd = process.env.CODE_BUDDY_CMD || process.env.AGENT_CLI_CMD;
    if (envCmd) return envCmd;
    const entry = resolveNodeEntry('@tencent-ai/codebuddy-code', ['codebuddy', 'cbc']);
    if (entry) return entry;
    if (process.platform === 'win32') {
      if (which('codebuddy.cmd')) return 'codebuddy.cmd';
      if (which('cbc.cmd')) return 'cbc.cmd';
      return 'codebuddy.cmd';
    }
    return which('codebuddy') ? 'codebuddy' : (which('cbc') ? 'cbc' : 'codebuddy');
  }
  function build(o) {
    const args = [];
    if (o.agentId) args.push('--agent', o.agentId, '--agents', o.agentsJson || '{}');
    args.push('-p', o.prompt, '--output-format', o.outputFormat || 'text');
    if (o.model && o.model !== 'auto') args.push('--model', o.model);
    if (o.fallbackModel && o.fallbackModel !== 'auto') args.push('--fallback-model', o.fallbackModel);
    if (o.permissions !== 'ask') args.push('--dangerously-skip-permissions');
    return args;
  }
  return {
    name: 'codebuddy',
    supportsFallbackFlag: true,
    capabilities: { model: true, agents: true },
    extraModels: loadCodebuddyCustomModels,
    label() { const b = bin(); return typeof b === 'object' ? `${b.node} ${b.entry}` : b; },
    probe() { return spawnCli(bin(), ['--version'], { timeoutMs: 15000 }); },
    run(o) { return spawnCli(bin(), build(o), { cwd: o.cwd, timeoutMs: o.timeoutMs }); },
  };
}

function claudeRunner() {
  function bin() {
    const envCmd = process.env.CLAUDE_CLI_CMD || process.env.AGENT_CLI_CMD;
    if (envCmd) return envCmd;
    const entry = resolveNodeEntry('@anthropic-ai/claude-code', ['claude']);
    if (entry) return entry;
    if (process.platform === 'win32') return which('claude.cmd') ? 'claude.cmd' : 'claude.cmd';
    return 'claude';
  }
  function build(o) {
    const args = ['-p', o.prompt, '--output-format', 'text'];
    if (o.agentDef && o.agentDef.prompt) args.push('--append-system-prompt', o.agentDef.prompt);
    if (o.model && o.model !== 'auto') args.push('--model', o.model);
    if (o.permissions !== 'ask') args.push('--dangerously-skip-permissions');
    return args;
  }
  return {
    name: 'claude',
    supportsFallbackFlag: false,
    capabilities: { model: true, agents: false },
    extraModels() { return []; },
    label() { const b = bin(); return typeof b === 'object' ? `${b.node} ${b.entry}` : b; },
    probe() { return spawnCli(bin(), ['--version'], { timeoutMs: 15000 }); },
    run(o) { return spawnCli(bin(), build(o), { cwd: o.cwd, timeoutMs: o.timeoutMs }); },
  };
}

function codexRunner() {
  function bin() {
    const envCmd = process.env.CODEX_CLI_CMD || process.env.AGENT_CLI_CMD;
    if (envCmd) return envCmd;
    if (process.platform === 'win32') return which('codex.cmd') ? 'codex.cmd' : 'codex.cmd';
    return 'codex';
  }
  function build(o) {
    const args = ['exec'];
    if (o.permissions !== 'ask') args.push('--full-auto');
    if (o.model && o.model !== 'auto') args.push('-m', o.model);
    args.push(roleHeader(o.agentDef) + o.prompt);
    return args;
  }
  return {
    name: 'codex',
    supportsFallbackFlag: false,
    capabilities: { model: true, agents: false },
    extraModels() { return []; },
    label() { return bin(); },
    probe() { return spawnCli(bin(), ['--version'], { timeoutMs: 15000 }); },
    run(o) { return spawnCli(bin(), build(o), { cwd: o.cwd, timeoutMs: o.timeoutMs }); },
  };
}

function plainRunner(cfg) {
  const plain = cfg.plain || {};
  const cmdStr = String(plain.command || '').trim();
  if (!cmdStr) {
    throw new Error('适配器 plain 需要在 config/cli.json 配置 plain.command（如 "my-agent --run"），或改用自动探测');
  }
  const parts = cmdStr.split(/\s+/);
  const binSpec = parts[0];
  const baseArgs = parts.slice(1).concat(plain.extraArgs || []);
  const stdinMode = plain.promptMode === 'stdin';
  return {
    name: 'plain',
    supportsFallbackFlag: false,
    capabilities: { model: false, agents: false },
    extraModels() { return []; },
    label() { return [binSpec].concat(baseArgs).join(' ') + (stdinMode ? ' (prompt via stdin)' : ''); },
    probe() { return spawnCli(binSpec, ['--version'], { timeoutMs: 15000 }); },
    run(o) {
      const finalPrompt = roleHeader(o.agentDef) + o.prompt;
      if (stdinMode) {
        return spawnCli(binSpec, baseArgs, { cwd: o.cwd, timeoutMs: o.timeoutMs, input: finalPrompt });
      }
      return spawnCli(binSpec, baseArgs.concat([finalPrompt]), { cwd: o.cwd, timeoutMs: o.timeoutMs });
    },
  };
}

// ---------- 工厂 ----------
function createRunner(cfg) {
  const name = resolveAdapterName(cfg);
  if (!name) {
    throw new Error('未探测到受支持的 agent CLI（codebuddy/cbc/claude/codex）。'
      + '请安装其一，或设置环境变量 AGENT_PIPELINE_ADAPTER=plain 并在 config/cli.json 填写 plain.command');
  }
  switch (name) {
    case 'codebuddy': return codebuddyRunner(cfg);
    case 'claude': return claudeRunner(cfg);
    case 'codex': return codexRunner(cfg);
    case 'plain': return plainRunner(cfg);
    default: throw new Error('未知适配器：' + name + '（可用：codebuddy/claude/codex/plain）');
  }
}

module.exports = { loadCliConfig, createRunner, isQuotaError, spawnCli, which, DEFAULTS };
