#!/usr/bin/env node
/**
 * CodeBuddy 多 Agent 编排流水线 - 主编排器
 *
 * 用法：
 *   node scripts/run-pipeline.js --project-name demo-app
 *   node scripts/run-pipeline.js --project-name demo-app --dry-run
 *   node scripts/run-pipeline.js --project-name demo-app --from 04-develop --to 06-test
 *   node scripts/run-pipeline.js --project-name demo-app --remote
 *     （远程确认模式：人不在电脑边时，confirm 阶段产出后暂停并以退出码 42 通知 Marvis，
 *       由 Marvis 读产物向你确认/收集意见，再以 --from <下一阶段> 或 --from <当前> --amend "<意见>" 续跑）
 *   node scripts/run-pipeline.js --project-name demo-app --project-root /path/to/workspace
 *     （项目根目录，缺省取当前工作目录；项目目录 = <project-root>/<project-name>，
 *       也可用 --project-dir 直接指定完整项目目录）
 *
 * 原理：按 pipeline.json 阶段顺序，每阶段调用一次 CodeBuddy CLI：
 *   codebuddy --agent <agent> --agents '<agentsJson>' -p "<阶段prompt>" \
 *             --output-format text --dangerously-skip-permissions
 * 其中 agents.json 里每个子代理自带 model，实现"不同 agent 不同模型"。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

// ---------- 工具函数 ----------
function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

function resolveCliCommand() {
  if (process.env.CODE_BUDDY_CMD) return process.env.CODE_BUDDY_CMD;
  if (process.platform === 'win32') {
    // 优先直接以 node 执行 CLI 的 JS 入口，规避 .cmd 包装器（spawn 直接跑 .cmd 会报 EINVAL）与 shell 转义
    try {
      const { execSync } = require('child_process');
      const globalRoot = execSync('npm root -g', { encoding: 'utf8', shell: 'cmd.exe' }).trim();
      const pkgDir = path.join(globalRoot, '@tencent-ai', 'codebuddy-code');
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
      const bin = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin && (pkg.bin.codebuddy || pkg.bin.cbc));
      const entry = bin ? path.join(pkgDir, bin) : '';
      if (entry && fs.existsSync(entry)) return { node: process.execPath, entry };
    } catch (e) { /* 退回 .cmd 兜底 */ }
    return 'codebuddy.cmd';
  }
  return 'codebuddy';
}

function replacePlaceholders(text, vars) {
  return text.replace(/\{(\w+)\}/g, (m, key) => (vars[key] !== undefined ? vars[key] : m));
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  const logsDir = path.join(ROOT, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.appendFileSync(path.join(logsDir, 'pipeline.log'), line + '\n');
}

// 从 ~/.codebuddy/models.json 读取 wb bridge（buddy-bridge）同步的自定义模型列表；CLI 完整 ID 为 custom-local:<id>
function loadCustomModels() {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const p = path.join(home, '.codebuddy', 'models.json');
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (data.models || []).map((m) => (m.id && m.id.startsWith('custom-local:') ? m.id : 'custom-local:' + m.id));
  } catch (e) {
    log('警告：读取自定义模型列表失败：' + e.message);
    return [];
  }
}

// ---------- 主编排 ----------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectName = args['project-name'];
  const projectRoot = args['project-root'] || process.cwd();
  const projectDir = args['project-dir'] || path.join(projectRoot, projectName);
  if (!projectName) {
    console.error('错误：必须提供 --project-name');
    process.exit(1);
  }
  // 项目根目录默认取当前工作目录（可用 --project-root 覆盖）；项目目录 = <根目录>/<项目名>，自动创建
  fs.mkdirSync(projectDir, { recursive: true });

  const dryRun = !!args['dry-run'];
  const agentsConfigPath = args['agents-config'] || 'config/agents.json';
  const pipelineConfigPath = args['pipeline-config'] || 'config/pipeline.json';
  const fromId = args['from'] || '01-product-plan';
  const toId = args['to'] || '07-deploy';
  const interactive = !!args['interactive'];
  const remote = !!args['remote'];
  const initOnly = !!args['init-only'];
  const amend = args['amend'] || null;

  const agentsConfig = readJson(agentsConfigPath);
  const pipeline = readJson(pipelineConfigPath);
  const agentsJson = JSON.stringify(agentsConfig.agents);

  const stages = pipeline.stages;
  const startIdx = stages.findIndex(s => s.id === fromId);
  const endIdx = stages.findIndex(s => s.id === toId);
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    console.error(`错误：阶段范围无效 from=${fromId} to=${toId}，可用阶段：${stages.map(s => s.id).join(', ')}`);
    process.exit(1);
  }

  const vars = { projectName, projectDir };
  const cliCmd = resolveCliCommand();

  // 执行 CLI：node 入口直跑（数组传参，规避 .cmd 的 EINVAL 与 shell 转义）；
  // 字符串型命令 win32 用 cmd /c 包装，非 win32 交给 shell 解析（跨平台）
  function runCli(args, cwd, timeoutMs) {
    const base = { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 };
    if (typeof cliCmd === 'object') {
      return spawnSync(cliCmd.node, [cliCmd.entry, ...args], Object.assign({ cwd }, base));
    }
    if (process.platform === 'win32') {
      const argStr = args.map(a => (/[\s"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a)).join(' ');
      return spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', `${cliCmd} ${argStr}`], Object.assign({ cwd }, base));
    }
    return spawnSync(cliCmd, args, Object.assign({ cwd, shell: true }, base));
  }

  // 检查 CLI 是否存在（dry-run 也检查，便于提前发现）
  const probe = runCli(['--version'], undefined, 15000);
  if (probe.error || probe.status !== 0) {
    console.error('错误：未找到 CodeBuddy CLI，请先执行 npm install -g @tencent-ai/codebuddy-code');
    process.exit(1);
  }
  log(`CLI 就绪：${typeof cliCmd === 'object' ? `node ${cliCmd.entry}` : cliCmd} ${probe.stdout ? probe.stdout.trim() : ''}`);

  log(`开始流水线：${projectName} @ ${projectDir}（阶段 ${fromId} → ${toId}${dryRun ? '，演练模式' : ''}）`);

  // 交互确认：审阅阶段产物，可输入修改意见让 agent 重跑该阶段
  function askUser(stage) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      console.log(`\n===== 阶段 ${stage.id}（${stage.name}）产物预览 =====`);
      if (stage.output) {
        const outAbs = path.join(ROOT, stage.output);
        if (fs.existsSync(outAbs)) {
          const content = fs.readFileSync(outAbs, 'utf8');
          console.log(content.length > 3000 ? content.slice(0, 3000) + `\n...(截断，完整见 ${stage.output})` : content);
        }
      }
      rl.question('\n[y] 确认继续  |  输入修改意见（多行，以 !done 结束）\n> ', (first) => {
        if (first.trim() === 'y') { rl.close(); resolve({ action: 'continue' }); return; }
        const lines = [first];
        rl.setPrompt('> ');
        rl.prompt();
        rl.on('line', (line) => {
          if (line.trim() === '!done') { rl.close(); resolve({ action: 'amend', text: lines.join('\n').trim() }); }
          else { lines.push(line); rl.prompt(); }
        });
      });
    });
  }

  // 限额/过载错误判定：命中则触发模型自动切换
  function isQuotaError(text) {
    return /quota|rate\s*limit|429|insufficient|overload|limit\s*exceeded|过载|限额|超限|额度不足/i.test(text || '');
  }

  // 执行单个阶段，extraAmend 为用户修订意见（追加进 prompt 后重跑）
  function runStage(stage, extraAmend) {
    const agentDef = agentsConfig.agents[stage.agent];
    if (!agentDef) { log(`[${stage.id}] 跳过：未找到 agent ${stage.agent}`); return { ok: true, skipped: true }; }

    const template = fs.readFileSync(path.join(ROOT, stage.promptFile), 'utf8');
    // 剥离 AIGC 水印 frontmatter（---\nAIGC:...\n---），防止 prompt 以 "-" 开头被 CLI 误解析为 option
    let prompt = replacePlaceholders(template.replace(/^---\nAIGC:[\s\S]*?\n---\n/, ''), vars);
    const contextParts = [];
    for (const inputRel of stage.input || []) {
      const inputAbs = path.join(ROOT, inputRel);
      if (fs.existsSync(inputAbs)) {
        contextParts.push(`\n\n===== 上下文输入：${inputRel} =====\n` + fs.readFileSync(inputAbs, 'utf8'));
      } else {
        log(`[${stage.id}] 警告：输入产物缺失 ${inputRel}，继续执行`);
      }
    }
    if (contextParts.length) prompt += contextParts.join('');
    if (extraAmend) prompt += `\n\n===== 用户修订意见（请据此更新产物，其余内容保持一致） =====\n` + extraAmend;

    const cmdArgsBase = [
      '--agent', stage.agent,
      '--agents', agentsJson,
      '-p', prompt,
      '--output-format', pipeline.cli.outputFormat || 'text',
    ];
    if (pipeline.cli.permissions !== 'ask') cmdArgsBase.push('--dangerously-skip-permissions');

    // 候选模型：显式主模型 + 显式 fallbackModels + 运行时自定义模型（wb bridge 经 ~/.codebuddy/models.json 同步），链尾 auto 兜底
    const dynamicModels = loadCustomModels();
    const explicitPrimary = stage.model && stage.model !== 'auto' ? stage.model : null;
    const primary = explicitPrimary || dynamicModels[0] || null;
    const candidates = [];
    if (primary) candidates.push(primary);
    for (const m of [...(stage.fallbackModels || []), ...(agentDef.fallbackModels || [])]) {
      if (m && m !== 'auto' && !candidates.includes(m)) candidates.push(m);
    }
    for (const m of dynamicModels) {
      if (m && !candidates.includes(m)) candidates.push(m);
    }
    if (candidates.length && !candidates.includes('auto')) candidates.push('auto');
    const modelList = candidates.length ? candidates : [null];

    const timeoutMs = pipeline.cli.timeoutMs || 600000;
    for (let ci = 0; ci < modelList.length; ci++) {
      const current = modelList[ci];
      const next = modelList[ci + 1] || null;
      const cmdArgs = [...cmdArgsBase];
      if (current && current !== 'auto') cmdArgs.push('--model', current); // auto = 不指定模型，交由 CLI 默认自动选择
      if (next && next !== 'auto') cmdArgs.push('--fallback-model', next); // CLI 层：主模型过载时自动回退

      const cliLabel = typeof cliCmd === 'object' ? `${cliCmd.node} ${cliCmd.entry}` : cliCmd;
      log(`[${stage.id}] ${stage.name}（agent=${stage.agent}）开始，模型=${current || '默认'}${next ? `，CLI回退=${next}` : ''}`);
      log(`[${stage.id}] 命令：${cliLabel} ${cmdArgs.slice(0, 5).join(' ')} ...`);

      if (dryRun) { log(`[${stage.id}] [演练] 不实际执行`); return { ok: true, dry: true }; }

      const result = runCli(cmdArgs, projectDir, timeoutMs);

      const stdout = (result.stdout || '').trim();
      const stderr = (result.stderr || '').trim();
      if (result.status === 0) {
        if (stage.output) {
          const outAbs = path.join(ROOT, stage.output);
          fs.mkdirSync(path.dirname(outAbs), { recursive: true });
          fs.writeFileSync(outAbs, stdout || '(空输出)\n');
          log(`[${stage.id}] 完成，产物已写入 ${stage.output}`);
        } else {
          log(`[${stage.id}] 完成（无产物文件，输出长度 ${stdout.length}）`);
        }
        return { ok: true, model: current || 'default' };
      }

      const errText = `${stderr}\n${stdout}`;
      const canSwitch = isQuotaError(errText) && ci < modelList.length - 1;
      log(`[${stage.id}] 执行失败：exit=${result.status} signal=${result.signal || '-'}`);
      if (canSwitch) {
        log(`[${stage.id}] 检测到模型限额/过载（${current || '默认'}），自动切换候选模型 → ${modelList[ci + 1]}`);
        if (stderr) log(`[${stage.id}] stderr: ${stderr.slice(0, 1500)}`);
        continue;
      }
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
        if (!stageResult.ok) { console.error(`\n阶段 ${stage.id} 失败，可用 --from ${stage.id} 断点重跑。`); process.exit(2); }
        if (stageResult.skipped || stageResult.dry) break;
        if (!((interactive || remote) && stage.confirm)) break;
        if (remote) {
          // 远程确认模式：不等待终端输入，落状态文件并退出，由 Marvis 中转确认/收集意见
          const nextId = i + 1 <= endIdx ? stages[i + 1].id : null;
          fs.writeFileSync(
            path.join(ROOT, 'artifacts/.confirm-state.json'),
            JSON.stringify({
              projectName, projectDir,
              stageId: stage.id, stageName: stage.name,
              output: stage.output || null,
              nextStageId: nextId,
              action: 'pending',
              updatedAt: new Date().toISOString(),
            }, null, 2)
          );
          log(`[${stage.id}] 远程确认模式：已暂停，等待 Marvis 确认（状态文件 artifacts/.confirm-state.json）`);
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
        console.log(nextId
          ? `\n需求已确认。继续自动执行：node scripts/run-pipeline.js --project-name ${projectName} --project-dir "${projectDir}" --from ${nextId}`
          : '\n需求已确认，流水线完成。');
        return;
      }
    }
    log(`流水线完成：${projectName}`);
    console.log('\n全部阶段执行完毕。产物见 artifacts/，日志见 logs/pipeline.log');
  })().catch((e) => { console.error(e); process.exit(1); });
}

main();
