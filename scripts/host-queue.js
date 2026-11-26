'use strict';
/**
 * host-queue.js —— 宿主侧工单队列操作（与 run-pipeline.js 配套，不使用任何 CLI）
 *
 * 用法：
 *   node scripts/host-queue.js --work-dir <dir> status            查看当前待派发工单
 *   node scripts/host-queue.js --work-dir <dir> list [--json]     查看待办 + 最近交付历史
 *   node scripts/host-queue.js --work-dir <dir> submit --file <f> 用文件内容回写当前工单结果
 *   node scripts/host-queue.js --work-dir <dir> submit --text "…" 直接用字符串回写结果
 *   node scripts/host-queue.js --work-dir <dir> cancel            作废当前待派发工单
 *
 * 典型宿主闭环：
 *   node scripts/run-pipeline.js …            → exit 3，产出 handoff/orders/<key>.md
 *   宿主按工单派发子 Agent，输出落到 out.md
 *   node scripts/host-queue.js --work-dir <dir> submit --file out.md
 *   node scripts/run-pipeline.js …            → 继续落产物 / 验收 / 进入下一阶段
 */

const fs = require('fs');
const path = require('path');
const host = require('./lib/host-adapter');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function usage() {
  console.log(`宿主工单队列（无 CLI 派发）

用法：node scripts/host-queue.js --work-dir <dir> <子命令> [选项]

子命令：
  status                  查看当前待派发工单（无人待办时提示空队列）
  list [--json]           待办 + 最近交付历史
  submit --file <path>    用文件内容回写当前工单结果（子 Agent 输出原文）
  submit --text "…"       用命令行字符串回写结果
  cancel                  作废当前待派发工单（会归档，可重跑重新生成）

选项：
  --work-dir <dir>        必填。与 run-pipeline.js 相同的 --work-dir
  --json                  以 JSON 输出（便于宿主解析）

说明：结果回写后需重新执行原 run-pipeline 命令，流水线才会继续。`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || !args['work-dir']) {
    usage();
    process.exit(1);
  }
  const workRoot = path.resolve(args['work-dir']);
  const cfg = host.loadConfig(workRoot, path.join(workRoot, 'config', 'host.json'));
  const queue = host.loadQueue(cfg);

  if (cmd === 'status' || cmd === 'list') {
    const payload = {
      workDir: workRoot,
      pending: queue.pending,
      updatedAt: queue.updatedAt,
      history: cmd === 'list' ? queue.history : queue.history.slice(-3),
    };
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    if (!queue.pending) {
      console.log('队列为空：当前没有待派发工单。');
      if (queue.history.length) {
        const last = queue.history[queue.history.length - 1];
        console.log(`最近一次：${last.status} · ${last.agentId} · ${last.key} · ${last.at}`);
      }
      return;
    }
    const p = queue.pending;
    console.log(`待派发角色：${p.agentId}（${p.title}）`);
    console.log(`工单文件：${p.orderAbs}`);
    console.log(`结果文件：${p.resultAbs}`);
    console.log(`正文长度：${p.promptChars} 字符 · 创建于 ${p.createdAt}`);
    if (queue.history.length) {
      console.log('最近交付：');
      for (const h of queue.history.slice(-5)) console.log(`  - ${h.status} · ${h.agentId} · ${h.key} · ${h.at}`);
    }
    return;
  }

  if (cmd === 'submit') {
    if (!queue.pending) {
      console.error('错误：当前没有待回写的工单。');
      process.exit(1);
    }
    let content;
    if (typeof args.file === 'string') {
      content = fs.readFileSync(path.resolve(args.file), 'utf8');
    } else if (typeof args.text === 'string') {
      content = args.text;
    } else {
      console.error('错误：submit 需要 --file <path> 或 --text "<内容>"。');
      process.exit(1);
    }
    if (!content.trim()) {
      console.error('错误：回写内容为空，已拒绝（空结果会让流水线误判阶段失败）。');
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(queue.pending.resultAbs), { recursive: true });
    fs.writeFileSync(queue.pending.resultAbs, content);
    console.log(`已回写结果：${queue.pending.resultAbs}（${content.length} 字符）`);
    console.log('下一步：重新执行原 run-pipeline 命令让流水线继续。');
    return;
  }

  if (cmd === 'cancel') {
    if (!queue.pending) {
      console.log('队列为空，无需作废。');
      return;
    }
    const p = queue.pending;
    queue.history.push({ key: p.key, agentId: p.agentId, status: 'cancelled', at: new Date().toISOString() });
    queue.pending = null;
    host.saveQueue(cfg, queue);
    console.log(`已作废工单：${p.key}（${p.agentId}）`);
    return;
  }

  console.error(`错误：未知子命令 ${cmd}`);
  usage();
  process.exit(1);
}

main();
