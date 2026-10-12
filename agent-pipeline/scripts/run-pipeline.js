#!/usr/bin/env node
/**
 * 多 Agent 流水线主编排器（便携版）—— 通过 CLI 适配层运行在任意 agent 环境
 *
 * 用法：
 *   node scripts/run-pipeline.js --project-name demo-app [--dry-run]
 *   node scripts/run-pipeline.js --project-name demo-app --from 04-develop --to 06-test
 *   node scripts/run-pipeline.js --project-name demo-app --interactive          # 交互引导（confirm 阶段暂停审阅）
 *   node scripts/run-pipeline.js --project-name demo-app --remote               # 远程确认（confirm 后写状态文件并 exit 42）
 *   node scripts/run-pipeline.js --project-name demo-app --from 03-architecture --amend "修订意见"
 *
 * 原理：按 pipeline.json 阶段顺序，每阶段经适配器（codebuddy/claude/codex/plain）调用一次 agent CLI，
 *       组装 prompt（模板 + 前序产物上下文 + 修订意见）→ 执行 → 产物落盘 artifacts/。
 * 可移植性：零 npm 依赖；路径全部相对 skill 根或 --work-dir；无平台硬编码；
 *          --work-dir 可把产物/日志/自定义模板与 config 放到任意工作目录。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const adapter = require('./lib/adapter');

const ROOT = path.resolve(__dirname, '..');

// ---------- 参数解析 ----------
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function replacePlaceholders(text, vars) {
  return text.replace(/\{(\w+)\}/g, (m, key) => (vars[key] !== undefined ? vars[key] : m));
}

function usage() {
  console.log(`多 Agent 流水线编排器（便携版）

用法：node scripts/run-pipeline.js --project-name <项目名> [选项]

选项：
  --project-name <n>    必填。项目名，注入各阶段 prompt 的 {projectName}
  --project-dir <dir>   项目代码目录（开发/测试/部署阶段的工作目录）
  --project-root <dir>  项目根目录；--project-dir 缺省时取 <project-root>/<project-name>，默认当前目录
  --work-dir <dir>      工作目录：artifacts/、logs/ 与自定义模板/配置的根，默认当前目录
  --from <stageId>      起始阶段 id，默认第一个阶段
  --to <stageId>        结束阶段 id，默认最后一个阶段
  --interactive         交互模式：confirm 阶段产出后暂停审阅，可输入修订意见重跑
  --remote              远程确认模式：confirm 阶段产出后写 artifacts/.confirm-state.json 并 exit 42
  --init-only           只跑前置段（到最后一个需确认的阶段）即退出
  --amend "<意见>"      把修订意见追加进 --from 指定阶段重新生成产物
  --dry-run             只打印将要执行的命令，不真正调用 CLI
  --pipeline-config <p> 流水线配置路径，默认 config/pipeline.json
  --agents-config <p>   子代理配置路径，默认 config/agents.json
  --cli-config <p>      CLI 适配配置路径，默认 config/cli.json
  --adapter <name>      强制指定适配器（codebuddy/claude/codex/plain），覆盖配置`);
}

// ---------- 主编排 ----------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectName = args['project-name'];
  if (!projectName) { usage(); process.exit(1); }

  // 工作目录：artifacts/logs/确认状态的根；默认当前目录，与 skill 安装目录分离（安装目录可只读）
  const workRoot = path.resolve(args['work-dir'] || process.cwd());
  const projectRoot = args['project-root'] || process.cwd();
  const projectDir = args['project-dir'] || path.join(projectRoot, projectName);
  fs.mkdirSync(projectDir, { recursive: true });

  // 资产解析：--work-dir 下的同名模板/配置优先（允许运行时定制覆盖），其次 skill 内置资产
  const resolveAsset = (rel) => {
    if (path.isAbsolute(rel)) return rel;
    const inWork = path.join(workRoot, rel);
    if (fs.existsSync(inWork)) return inWork;
    return path.join(ROOT, rel);
  };
  // 产物路径：始终基于工作目录（跨运行隔离、可移植）
  const resolveWork = (rel) => (path.isAbsolute(rel) ? rel : path.join(workRoot, rel));

  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try {
      const logsDir = path.join(workRoot, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      fs.appendFileSync(path.join(logsDir, 'pipeline.log'), line + '\n');
    } catch (e) { /* 日志失败不中断 */ }
  };

  // ---------- 配置与适配器 ----------
  let cliCfg, pipeline, agentsConfig, agentsJson;
  try {
    cliCfg = adapter.loadCliConfig(ROOT, resolveAsset(args['cli-config'] || 'config/cli.json'), { adapter: args['adapter'] });
    pipeline = readJson(resolveAsset(args['pipeline-config'] || 'config/pipeline.json'));
    agentsConfig = readJson(resolveAsset(args['agents-config'] || 'config/agents.json'));
  } catch (e) {
    console.error('错误：读取配置失败：' + e.message);
    process.exit(1);
  }
  agentsJson = JSON.stringify(agentsConfig.agents);

  // 向后兼容：旧版 pipeline.json 内嵌 cli 块
  if (pipeline.cli) {
    if (pipeline.cli.timeoutMs) cliCfg.timeoutMs = pipeline.cli.timeoutMs;
    if (pipeline.cli.permissions) cliCfg.permissions = pipeline.cli.permissions;
    if (pipeline.cli.outputFormat) cliCfg.outputFormat = pipeline.cli.outputFormat;
  }

  const dryRun = !!args['dry-run'];
  const interactive = !!args['interactive'];
  const remote = !!args['remote'];
  const initOnly = !!args['init-only'];
  const amend = args['amend'] || null;

  const stages = pipeline.stages;
  const fromId = args['from'] || stages[0].id;
  const toId = args['to'] || stages[stages.length - 1].id;
  const startIdx = stages.findIndex((s) => s.id === fromId);
  const endIdx = stages.findIndex((s) => s.id === toId);
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    console.error(`错误：阶段范围无效 from=${fromId} to=${toId}，可用阶段：${stages.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }

  let runner;
  try {
    runner = adapter.createRunner(cliCfg);
  } catch (e) {
    console.error('错误：' + e.message);
    process.exit(1);
  }

  // 探测 CLI 可用性（dry-run 也探测，便于提前发现问题；plain 适配器宽松处理）
  const probe = runner.probe();
  if (probe.error || probe.status !== 0) {
    const detail = String((probe.stderr || '') || (probe.stdout || '') || (probe.error && probe.error.message) || '').trim().slice(0, 300);
    if (runner.name === 'plain') {
      log(`警告：plain 适配器探测未通过（--version），继续尝试执行：${runner.label()}${detail ? '；详情：' + detail : ''}`);
    } else {
      console.error(`错误：agent CLI 不可用（适配器=${runner.name}，命令=${runner.label()}）。`);
      if (detail) console.error('详情：' + detail.replace(/\n+/g, ' ').trim());
      console.error('请安装对应 CLI 或修复其运行环境，也可通过 config/cli.json / 环境变量 AGENT_PIPELINE_ADAPTER 指定其他适配器');
      process.exit(1);
    }
  } else {
    log(`CLI 就绪：适配器=${runner.name}，命令=${runner.label()} ${String(probe.stdout || '').trim()}`);
  }

  const vars = { projectName, projectDir };
  log(`开始流水线：${projectName} @ ${projectDir}（阶段 ${fromId} → ${toId}${dryRun ? '，演练模式' : ''}）`);

  // 交互确认：审阅阶段产物，可输入修改意见让 agent 重跑该阶段
  // 实现说明：readline 的 question 是一次性注册，若输入行在下一个 question 注册前到达（管道/expect
  // 一次性喂入、或 agent 自动驱动）会被丢弃。改为常驻 line 监听 + 行队列，任意节奏到达都不丢。
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lineQueue = [];
  let lineWaiter = null;
  rl.on('line', (line) => {
    if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(line); }
    else lineQueue.push(line);
  });
  function nextLine() {
    return new Promise((resolve) => {
      if (lineQueue.length) resolve(lineQueue.shift());
      else lineWaiter = resolve;
    });
  }
  async function askUser(stage) {
    console.log(`\n===== 阶段 ${stage.id}（${stage.name}）产物预览 =====`);
    if (stage.output) {
      const outAbs = resolveWork(stage.output);
      if (fs.existsSync(outAbs)) {
        const content = fs.readFileSync(outAbs, 'utf8');
        console.log(content.length > 3000 ? content.slice(0, 3000) + `\n...(截断，完整见 ${stage.output})` : content);
      }
    }
    process.stdout.write('\n[y] 确认继续  |  输入修改意见（多行，以 !done 结束）\n> ');
    const first = await nextLine();
    if (first.trim() === 'y') { return { action: 'continue' }; }
    const lines = [first];
    process.stdout.write('> ');
    for (;;) {
      const line = await nextLine();
      if (line.trim() === '!done') { return { action: 'amend', text: lines.join('\n').trim() }; }
      lines.push(line);
      process.stdout.write('> ');
    }
  }

  // 执行单个阶段：组装 prompt → 经适配器调用 CLI → 产物落盘；限额/过载自动切换模型重跑
  function runStage(stage, extraAmend) {
    const agentDef = agentsConfig.agents[stage.agent];
    if (!agentDef) { log(`[${stage.id}] 跳过：未找到 agent ${stage.agent}`); return { ok: true, skipped: true }; }

    let template;
    try {
      template = fs.readFileSync(resolveAsset(stage.promptFile), 'utf8');
    } catch (e) {
      log(`[${stage.id}] 失败：提示词模板不存在 ${stage.promptFile}`);
      return { ok: false, errText: e.message };
    }
    // 兼容：剥离可能存在的 AIGC 水印 frontmatter，防止 prompt 以 "-" 开头被 CLI 误解析为 option
    let prompt = replacePlaceholders(template.replace(/^---\r?\nAIGC:[\s\S]*?\r?\n---\r?\n/, ''), vars);

    const contextParts = [];
    for (const inputRel of stage.input || []) {
      const inputAbs = resolveWork(inputRel);
      if (fs.existsSync(inputAbs)) {
        contextParts.push(`\n\n===== 上下文输入：${inputRel} =====\n` + fs.readFileSync(inputAbs, 'utf8'));
      } else {
        log(`[${stage.id}] 警告：输入产物缺失 ${inputRel}，继续执行`);
      }
    }
    if (contextParts.length) prompt += contextParts.join('');
    if (extraAmend) prompt += `\n\n===== 用户修订意见（请据此更新产物，其余内容保持一致） =====\n` + extraAmend;

    // 模型候选链：阶段级显式模型 > 代理级模型 > 阶段/代理 fallbackModels > 适配器动态模型 > auto
    const canModel = !!(runner.capabilities && runner.capabilities.model);
    const explicitPrimary = (stage.model && stage.model !== 'auto')
      ? stage.model
      : ((agentDef.model && agentDef.model !== 'auto') ? agentDef.model : null);
    const candidates = [];
    if (explicitPrimary) candidates.push(explicitPrimary);
    for (const m of [].concat(stage.fallbackModels || [], agentDef.fallbackModels || [])) {
      if (m && m !== 'auto' && !candidates.includes(m)) candidates.push(m);
    }
    if (canModel) {
      for (const m of runner.extraModels()) {
        if (m && !candidates.includes(m)) candidates.push(m);
      }
      if (candidates.length && !candidates.includes('auto')) candidates.push('auto');
    }
    const modelList = candidates.length ? candidates : [null];

    const timeoutMs = cliCfg.timeoutMs || 600000;
    for (let ci = 0; ci < modelList.length; ci++) {
      const current = modelList[ci];
      const next = modelList[ci + 1] || null;
      const fb = runner.supportsFallbackFlag ? next : null;

      log(`[${stage.id}] ${stage.name}（agent=${stage.agent}@${runner.name}）开始，模型=${current || '默认'}${fb ? `，CLI回退=${fb}` : ''}`);
      log(`[${stage.id}] 命令：${runner.label()} -p <prompt ${prompt.length} 字符> ...`);

      if (dryRun) { log(`[${stage.id}] [演练] 不实际执行`); return { ok: true, dry: true }; }

      const result = runner.run({
        prompt,
        agentId: stage.agent,
        agentDef,
        agentsJson,
        model: current,
        fallbackModel: fb,
        cwd: projectDir,
        timeoutMs,
        permissions: cliCfg.permissions,
        outputFormat: cliCfg.outputFormat,
      });

      const stdout = (result.stdout || '').trim();
      const stderr = (result.stderr || '').trim();
      if (result.status === 0) {
        if (stage.output) {
          const outAbs = resolveWork(stage.output);
          fs.mkdirSync(path.dirname(outAbs), { recursive: true });
          fs.writeFileSync(outAbs, stdout || '(空输出)\n');
          log(`[${stage.id}] 完成，产物已写入 ${stage.output}`);
        } else {
          log(`[${stage.id}] 完成（无产物文件，输出长度 ${stdout.length}）`);
        }
        return { ok: true, model: current || 'default' };
      }

      const errText = `${stderr}\n${stdout}`;
      const canSwitch = adapter.isQuotaError(errText) && ci < modelList.length - 1;
      log(`[${stage.id}] 执行失败：exit=${result.status} signal=${result.signal || '-'}`);
      if (canSwitch) {
        log(`[${stage.id}] 检测到模型限额/过载（${current || '默认'}），自动切换候选模型 → ${modelList[ci + 1]}`);
        if (stderr) log(`[${stage.id}] stderr: ${stderr.slice(0, 1500)}`);
        continue;
      }
      if (result.error) log(`[${stage.id}] error: ${result.error.message}`);
      if (stderr) log(`[${stage.id}] stderr: ${stderr.slice(0, 2000)}`);
      if (stdout) log(`[${stage.id}] stdout 尾部: ${stdout.slice(-2000)}`);
      return { ok: false, errText };
    }
    return { ok: false };
  }

  (async () => {
    for (let i = startIdx; i <= endIdx; i++) {
      const stage = stages[i];
      let extraAmend = amend && stage.id === fromId ? amend : null;
      let stageResult;
      do {
        stageResult = runStage(stage, extraAmend);
        if (!stageResult.ok) {
          console.error(`\n阶段 ${stage.id} 失败，可用 --from ${stage.id} 断点重跑。`);
          process.exit(2);
        }
        if (stageResult.skipped || stageResult.dry) break;
        if (!((interactive || remote) && stage.confirm)) break;
        if (remote) {
          // 远程确认模式：不等待终端输入，落状态文件并退出，由外部（IM/机器人）中转确认/收集意见
          const nextId = i + 1 <= endIdx ? stages[i + 1].id : null;
          const stateAbs = resolveWork('artifacts/.confirm-state.json');
          fs.mkdirSync(path.dirname(stateAbs), { recursive: true });
          fs.writeFileSync(stateAbs, JSON.stringify({
            projectName, projectDir,
            stageId: stage.id, stageName: stage.name,
            output: stage.output || null,
            nextStageId: nextId,
            action: 'pending',
            updatedAt: new Date().toISOString(),
          }, null, 2));
          log(`[${stage.id}] 远程确认模式：已暂停（状态文件 ${path.relative(workRoot, stateAbs) || stateAbs}）`);
          console.log('\nREMOTE_CONFIRM_NEEDED');
          process.exit(42);
        }
        const answer = await askUser(stage);
        if (answer.action === 'continue') break;
        extraAmend = answer.text;
        log(`[${stage.id}] 收到修订意见（${answer.text.length} 字符），重新执行`);
      } while (true);

      if (initOnly && stage.confirm) {
        const nextId = i + 1 <= endIdx ? stages[i + 1].id : null;
        log(`[${stage.id}] 交互引导结束（--init-only）`);
        rl.close();
        console.log(nextId
          ? `\n需求已确认。继续自动执行：node scripts/run-pipeline.js --project-name ${projectName} --project-dir "${projectDir}" --from ${nextId}`
          : '\n需求已确认，流水线完成。');
        return;
      }
    }
    log(`流水线完成：${projectName}`);
    rl.close();
    console.log('\n全部阶段执行完毕。产物见 artifacts/，日志见 logs/pipeline.log');
  })().catch((e) => { console.error(e); process.exit(1); });
}

main();
