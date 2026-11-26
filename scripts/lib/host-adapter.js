'use strict';
/**
 * host-adapter.js —— 无 CLI 的宿主派发执行层
 *
 * 设计目标：与 v1.3.0 的 adapter.js 保持同一 runner 接口（name / label / capabilities /
 * probe / run / extraModels / supportsFallbackFlag），但 **不启动任何外部进程、不依赖任何 agent CLI**。
 *
 * 执行模型（三段式往返）：
 *   1. 脚本推进到某阶段，调用 runner.run({ prompt, agentId, ... })
 *   2. 结果文件不存在 → 把完整任务正文写成「阶段工单」，登记到 handoff/queue.json，进程以退出码 3
 *      退出（WAITING_HOST），把执行权交给宿主 Agent（Marvis 主 Agent 等）
 *   3. 宿主用自身派发能力（如 dispatch_task / 子 Agent）执行工单，把子 Agent 输出全文回写结果文件后
 *      重新运行同一条命令；run() 读到结果 → 作为本阶段输出返回，流水线继续（产物落盘、项目经理验收）
 *
 * 工单键（key）取「阶段标识--角色」，例如 05-code-review--code-reviewer、pm-dispatch--project-manager，
 * 保证同一阶段重跑（含宿主回写后重跑）稳定命中同一份工单；同时记录任务正文哈希（promptHash），
 * 任务正文变化即判定工单过期：旧工单与旧结果一并归档，重新出单，避免用旧结果冒充新任务。
 *
 * 目录约定（均在 --work-dir 下）：
 *   handoff/queue.json          当前待派发工单（同一时刻最多一条，串行推进）
 *   handoff/orders/<key>.md     阶段工单（任务正文 + 派发说明 + 交付要求）
 *   handoff/results/<key>.md    宿主回写的结果（被消费后归档）
 *   handoff/done/               已消费的工单与结果
 *
 * 测试可用：环境变量 AGENT_PIPELINE_FAKE_SCRIPT 指向一个 CommonJS 模块，其 exports.respond(prompt, ctx)
 * 返回字符串即视为该阶段输出（进程内调用，不 spawn 任何进程），用于端到端跑通状态机。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** 退出码 3：等待宿主执行工单（与 0 成功 / 1 配置错误 / 2 阶段失败 / 42 等待人工决策并存） */
const WAITING_HOST_EXIT = 3;

const DEFAULT_CONFIG = {
  mode: 'host',
  orderDir: 'handoff/orders',
  resultDir: 'handoff/results',
  doneDir: 'handoff/done',
  execDir: 'handoff/executions',
  queueFile: 'handoff/queue.json',
  keepDone: 40,
  timeoutMs: 0,
  permissions: 'n/a',
  outputFormat: 'text',
  fakeScript: '',
  _comment: '宿主派发配置：工单/结果/归档目录均相对 --work-dir。timeoutMs/permissions/outputFormat 仅为兼容旧配置保留，host 模式下不生效。',
};

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** 工单键：由任务正文哈希决定，保证同一份任务正文可稳定对应同一个结果文件 */
function orderKey(prompt) {
  return crypto.createHash('sha1').update(String(prompt || ''), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 读取宿主派发配置。
 * @param {string} workRoot 工作目录（--work-dir 解析后的绝对路径）
 * @param {string} cfgPath  config/host.json 路径（可不存在）
 * @param {object} overrides 命令行覆盖项（如 fakeScript）
 */
function loadConfig(workRoot, cfgPath, overrides = {}) {
  let fileCfg = {};
  if (cfgPath) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`宿主派发配置读取失败（${cfgPath}）：${error.message}`);
    }
  }
  const cfg = Object.assign({}, DEFAULT_CONFIG, fileCfg, overrides);
  cfg.workRoot = workRoot;
  cfg.orderAbs = path.resolve(workRoot, cfg.orderDir);
  cfg.resultAbs = path.resolve(workRoot, cfg.resultDir);
  cfg.doneAbs = path.resolve(workRoot, cfg.doneDir);
  cfg.execAbs = path.resolve(workRoot, cfg.execDir);
  cfg.queueAbs = path.resolve(workRoot, cfg.queueFile);
  cfg.fakeScript = cfg.fakeScript || process.env.AGENT_PIPELINE_FAKE_SCRIPT || '';
  if (cfg.fakeScript) {
    cfg.fakeScript = path.resolve(cfg.fakeScript);
    cfg.mode = 'fake';
  }
  return cfg;
}

function emptyQueue() {
  return { version: 1, updatedAt: new Date().toISOString(), pending: null, history: [] };
}

function loadQueue(cfg) {
  return readJsonSafe(cfg.queueAbs, emptyQueue());
}

function saveQueue(cfg, queue) {
  queue.updatedAt = new Date().toISOString();
  if (queue.history.length > cfg.keepDone) queue.history = queue.history.slice(-cfg.keepDone);
  writeJsonAtomic(cfg.queueAbs, queue);
}

/** 重跑命令：把当前进程的启动方式还原成可直接粘贴的一行命令 */
function rerunCommand() {
  const argv = process.argv.slice(1).map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a));
  return `${process.execPath} ${argv.join(' ')}`;
}

function clip(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** 从任务正文里取一个人类可读的标题（首个 Markdown 一级标题或角色提示词首行） */
function titleOf(prompt, agentId) {
  const h1 = String(prompt || '').match(/^#\s+(.+)$/m);
  if (h1) return clip(h1[1], 60);
  const first = String(prompt || '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('---'));
  return first ? clip(first, 60) : agentId;
}

/** 生成阶段工单全文 */
function buildOrder(cfg, ctx) {
  const { key, agentId, agentDef, prompt, cwd } = ctx;
  const name = (agentDef && (agentDef.name || agentDef.title)) || agentId;
  const desc = agentDef && (agentDef.description || agentDef.persona) ? String(agentDef.description || agentDef.persona) : '';
  const orderRel = path.relative(cfg.workRoot, ctx.orderAbs) || ctx.orderAbs;
  const resultRel = path.relative(cfg.workRoot, ctx.resultAbs) || ctx.resultAbs;
  const cmd = rerunCommand();
  const lines = [];
  lines.push(`# 阶段工单：${agentId}（${name}）`);
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| 工单键 | \`${key}\` |`);
  lines.push(`| 正文哈希 | \`${String(ctx.promptHash || '').slice(0, 12)}\` |`);
  lines.push(`| 执行角色 | \`${agentId}\`${desc ? `（${clip(desc, 80)}）` : ''} |`);
  lines.push(`| 项目 | ${cfg.projectName || '（未提供）'} |`);
  lines.push(`| 代码目录 | ${cwd || '（未提供）'} |`);
  lines.push(`| 工单文件 | \`${orderRel}\` |`);
  lines.push(`| 结果文件 | \`${resultRel}\` |`);
  lines.push(`| 创建时间 | ${new Date().toISOString()} |`);
  lines.push('');
  lines.push('## 一、给宿主的执行步骤（不使用任何 CLI）');
  lines.push('');
  lines.push('1. 读取下文「三、任务正文」，作为子 Agent 的任务材料派发执行（Marvis 用 `dispatch_task`，其它宿主用各自的子 Agent / 内置执行能力）。**不要启动 codebuddy / claude / codex 等任何外部 CLI。**');
  lines.push('2. 子 Agent 完成后，把它输出的**全文**（含正文与各类 `===== XXX =====` 标记段，不要删改、不要额外加工）回写结果文件：');
  lines.push('');
  lines.push('   ```bash');
  lines.push(`   node scripts/host-queue.js --work-dir "${cfg.workRoot}" submit --file <子Agent输出文件>`);
  lines.push('   ```');
  lines.push('');
  lines.push(`   也可以直接把全文写入 \`${ctx.resultAbs}\`。`);
  lines.push('3. 回写后重新执行原命令，流水线自动继续（落产物、项目经理验收、进入下一阶段）：');
  lines.push('');
  lines.push('   ```bash');
  lines.push(`   ${cmd}`);
  lines.push('   ```');
  lines.push('');
  lines.push('## 二、交付要求');
  lines.push('');
  lines.push(`- 结果文件只放子 Agent 的输出原文；脚本会自行剥离 \`REPORT\` / \`KNOWLEDGE\` / \`MEMORY\` / \`DELEGATE\` 标记段，正文用作阶段产物。`);
  lines.push('- 若「任务正文」要求输出 `===== REPORT =====` 或 `===== DECISION =====` 标记段，必须完整保留，否则本阶段按失败关闭（exit 2）。');
  lines.push('- 未完成、只完成部分或需要决策时，按协议如实写 `status`/`verdict`，不要为了推进而伪造通过。');
  lines.push('');
  lines.push('## 三、任务正文');
  lines.push('');
  lines.push('<!-- 以下为编排器组装好的完整任务正文，原样交给子 Agent -->');
  lines.push('');
  lines.push(prompt);
  lines.push('');
  return lines.join('\n');
}

/**
 * 任务正文指纹：先归一化 ISO 时间戳再哈希。
 * 项目经理状态文件里的 updatedAt / at 每轮都会刷新，直接对原文哈希会让「同一阶段重跑」误判为任务变化，
 * 导致刚回写的结果被判过期、工单反复重建；归一化后只有实质内容（产物、任务书、返工意见）变化才会换指纹。
 */
function promptFingerprint(prompt) {
  const normalized = String(prompt || '').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<ts>');
  return orderKey(normalized);
}

/** 把已消费的工单与结果移入归档目录 */
function archive(cfg, key, agentId, orderAbs, resultAbs) {
  try {
    fs.mkdirSync(cfg.doneAbs, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `${key}-${agentId}-${stamp}`;
    if (fs.existsSync(orderAbs)) fs.renameSync(orderAbs, path.join(cfg.doneAbs, `${base}.order.md`));
    if (fs.existsSync(resultAbs)) fs.renameSync(resultAbs, path.join(cfg.doneAbs, `${base}.result.md`));
  } catch (e) {
    /* 归档失败不影响主流程 */
  }
}

function fakeRespond(cfg, req) {
  let mod = require(cfg.fakeScript);
  if (mod && typeof mod !== 'function' && typeof mod.respond === 'function') mod = mod.respond;
  if (typeof mod !== 'function') throw new Error(`AGENT_PIPELINE_FAKE_SCRIPT 必须导出函数或 respond()：${cfg.fakeScript}`);
  const out = mod(String(req.prompt || ''), { agentId: req.agentId, agentDef: req.agentDef, cwd: req.cwd, cfg });
  return typeof out === 'string' ? out : JSON.stringify(out);
}

/** 稳定工单键：阶段标识 + 角色（无 stageId 时退化为任务正文哈希） */
function stageKeyOf(req, prompt) {
  const raw = req && req.stageId ? `${req.stageId}--${req.agentId || 'agent'}` : orderKey(prompt);
  return String(raw).replace(/[^A-Za-z0-9._-]+/g, '_');
}

/** 等待宿主的提示横幅 */
function banner(cfg, info) {
  return [
    '',
    '──────────── 等待宿主执行（未调用任何 CLI） ────────────',
    `阶段角色：${info.agentId}`,
    `工单键　：${info.key}`,
    `任务正文：${info.promptChars} 字符，指纹 ${String(info.promptHash).slice(0, 12)}`,
    `工单文件：${info.orderAbs}`,
    `结果文件：${info.resultAbs}`,
    `派发方式：读取工单 → 宿主派发子 Agent → node scripts/host-queue.js --work-dir "${cfg.workRoot}" submit --file <输出文件>`,
    `继续命令：${rerunCommand()}`,
    '──────────────────────────────────────────────────────',
  ].join('\n');
}

/**
 * 阶段级结果缓存：已消费的输出按工单键留档，供同阶段重跑时重放。
 * 宿主模式每条命令都会重新启动进程，同一阶段会被反复推进到；靠缓存保证「一次执行、多次重放」，
 * 从而让整条流水线在多轮运行中收敛，而不是每轮把已完成阶段重新派发一遍。
 */
function execPaths(cfg, key) {
  return {
    bodyAbs: path.join(cfg.execAbs, `${key}.result.md`),
    metaAbs: path.join(cfg.execAbs, `${key}.meta.json`),
  };
}

function saveExecution(cfg, info) {
  try {
    const { bodyAbs, metaAbs } = execPaths(cfg, info.key);
    fs.mkdirSync(cfg.execAbs, { recursive: true });
    fs.writeFileSync(bodyAbs, info.stdout);
    writeJsonAtomic(metaAbs, {
      key: info.key,
      agentId: info.agentId,
      stageId: info.stageId || null,
      promptHash: info.promptHash,
      chars: String(info.stdout || '').length,
      at: new Date().toISOString(),
    });
  } catch (e) {
    /* 缓存写入失败不影响主流程 */
  }
}

function loadExecution(cfg, key, promptHash) {
  const { bodyAbs, metaAbs } = execPaths(cfg, key);
  const meta = readJsonSafe(metaAbs, null);
  if (!meta || meta.promptHash !== promptHash) return null;
  if (!fs.existsSync(bodyAbs)) return null;
  return { stdout: fs.readFileSync(bodyAbs, 'utf8'), meta };
}

/**
 * 单阶段执行入口：
 *   1. 有待办且就是本阶段：有结果 → 消费；指纹不同 → 旧单作废重出；否则继续等待
 *   2. 无本阶段待办：中断遗留结果 → 消费；命中阶段缓存 → 直接重放；否则出新单
 * 返回结构与 CLI 适配器一致：{ status, stdout, stderr }。
 */
function runHost(cfg, req) {
  if (cfg.mode === 'fake') {
    try {
      return { status: 0, stdout: fakeRespond(cfg, req), stderr: '' };
    } catch (error) {
      return { status: 1, stdout: '', stderr: error.message, error };
    }
  }

  const prompt = String(req.prompt || '');
  const agentId = req.agentId || 'agent';
  const stageId = req.stageId || null;
  const key = stageKeyOf(req, prompt);
  const promptHash = promptFingerprint(prompt);
  const orderAbs = path.join(cfg.orderAbs, `${key}.order.md`);
  const resultAbs = path.join(cfg.resultAbs, `${key}.result.md`);
  const queue = loadQueue(cfg);
  const pending = queue.pending;
  // 存在性必须在归档动作之后重新判断：supersede 会把旧结果移入归档，提前取的值可能已经失效
  const hasResult = () => fs.existsSync(resultAbs);

  const consume = (stdout) => {
    if (pending && pending.key === key) queue.pending = null;
    queue.history.push({ key, agentId, status: 'consumed', promptHash, at: new Date().toISOString() });
    saveQueue(cfg, queue);
    saveExecution(cfg, { key, agentId, stageId, promptHash, stdout });
    archive(cfg, key, agentId, orderAbs, resultAbs);
    return { status: 0, stdout, stderr: '' };
  };

  const supersede = (target) => {
    queue.history.push({
      key: target.key,
      agentId: target.agentId,
      status: 'superseded',
      promptHash: target.promptHash,
      at: new Date().toISOString(),
    });
    archive(cfg, target.key, target.agentId, target.orderAbs, target.resultAbs);
    queue.pending = null;
  };

  // 1) 有待办且就是本阶段
  if (pending && pending.key === key) {
    if (pending.promptHash === promptHash) {
      if (hasResult()) return consume(fs.readFileSync(resultAbs, 'utf8'));
      console.log(banner(cfg, { agentId, key, promptHash, promptChars: prompt.length, orderAbs, resultAbs }));
      process.exit(WAITING_HOST_EXIT);
    }
    supersede(pending);
  } else if (pending) {
    // 待办属于其它阶段：阶段/角色已推进，旧的未消费工单直接作废
    supersede(pending);
  }

  // 2) 本阶段已有回写结果（进程中断遗留）→ 消费
  if (hasResult()) return consume(fs.readFileSync(resultAbs, 'utf8'));

  // 3) 命中阶段缓存 → 重放，不再要求重新派发
  const cached = loadExecution(cfg, key, promptHash);
  if (cached) return { status: 0, stdout: cached.stdout, stderr: '', replayed: true };

  // 4) 出新单
  const body = buildOrder(cfg, { key, promptHash, agentId, agentDef: req.agentDef, prompt, cwd: req.cwd, orderAbs, resultAbs });
  fs.mkdirSync(path.dirname(orderAbs), { recursive: true });
  fs.writeFileSync(orderAbs, body);
  queue.pending = {
    key,
    agentId,
    stageId,
    promptHash,
    title: titleOf(prompt, agentId),
    projectName: cfg.projectName || null,
    orderAbs,
    resultAbs,
    promptChars: prompt.length,
    createdAt: new Date().toISOString(),
  };
  saveQueue(cfg, queue);

  console.log(banner(cfg, { agentId, key, promptHash, promptChars: prompt.length, orderAbs, resultAbs }));
  process.exit(WAITING_HOST_EXIT);
}

function createRunner(cfg) {
  return {
    name: 'host',
    placeholder: false,
    label: () => '宿主派发（dispatch_task / 子 Agent，无 CLI）',
    capabilities: { model: false, agents: false, tools: false },
    supportsFallbackFlag: false,
    extraModels: () => [],
    probe: () => ({
      status: 0,
      stdout: cfg.mode === 'fake'
        ? `宿主派发（fake 模式：${cfg.fakeScript}）`
        : '宿主派发（无 CLI：工单落盘 + 宿主执行 + 结果回写）',
    }),
    run: (req) => runHost(cfg, req),
  };
}

/** host 模式不存在模型限额换号问题，保留该接口以兼容调用点 */
function isQuotaError() {
  return false;
}

module.exports = {
  WAITING_HOST_EXIT,
  DEFAULT_CONFIG,
  loadConfig,
  createRunner,
  isQuotaError,
  orderKey,
  buildOrder,
  loadQueue,
  saveQueue,
  rerunCommand,
};
