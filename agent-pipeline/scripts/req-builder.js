#!/usr/bin/env node
/**
 * 需求构建器 —— 流水线前置（便携版，经 CLI 适配层调用任意 agent CLI）
 *
 * 流程：引导用户按 7 维度格式描述需求 → AI 整理为双版本提示词 → 用户选择版本 → 写入 artifacts/00-requirement.md
 *
 * 用法：
 *   node scripts/req-builder.js --guide                          # 输出需求描述引导模板（7 维度格式）
 *   node scripts/req-builder.js --build "<用户需求文本>"          # AI 整理：精简通用版 + 高阶顶配版
 *   node scripts/req-builder.js --build "<文本>" --dry-run        # 演练：只打印完整提示词，不调用 CLI
 *   node scripts/req-builder.js --select A|B [--remote]          # 选择版本 → 写入 artifacts/00-requirement.md
 *   node scripts/req-builder.js --select A --auto-run --project-name demo-app
 *                                                                # 选版后自动续跑流水线（透传参数）
 *
 * 产物衔接：00-requirement.md 生成后，继续执行
 *   node scripts/run-pipeline.js --project-name <项目名> --from 01-product-plan
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
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

// 工作目录：artifacts/logs 与运行状态的根，默认当前目录（与 skill 安装目录分离）
const ARGS = parseArgs(process.argv.slice(2));
const WORK_ROOT = path.resolve(ARGS['work-dir'] || process.cwd());

// ---------- 引导模板 ----------
const GUIDE = [
  '请按以下格式描述你的需求（每条一行，缺项可写"无/待定"，信息越具体越好）：',
  '',
  '一、角色与目标',
  '  锁定身份、任务边界、成功标准。例：我是XX岗位，要做XX，成功标准是XX。',
  '二、必须核实的目标行为',
  '  逐条列出预期行为与禁止行为。例：预期：A/B/C；禁止：X/Y/Z。',
  '三、代码与配置审计',
  '  明确需读取的文件清单与检查点。例：需要查看的文件：…；检查点：…。',
  '四、核心方案设计',
  '  分方案对比、推荐决策、取舍说明。例：方案1…方案2…推荐…因为…。',
  '五、隔离与校验规则',
  '  防错机制、失败条件、边界约束。例：不得改动…；失败条件…；边界…。',
  '六、实施与交付要求',
  '  分步骤执行顺序，缺信息时先审计再列阻碍。例：步骤1…2…；缺信息时先做审计并列出阻碍项。',
  '七、验收标准',
  '  可逐条验证的检查清单。例：□A □B □C。',
  '',
  '填写完成后发送给我，我将作为提示词架构师整理为「精简通用版」与「高阶顶配版」两个版本供你选择。',
].join('\n');

// ---------- 工具函数 ----------
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    const logsDir = path.join(WORK_ROOT, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(path.join(logsDir, 'pipeline.log'), line + '\n');
  } catch (e) { /* 日志失败不中断 */ }
}

// ---------- 主流程 ----------
function main() {
  const args = ARGS;
  const dryRun = !!args['dry-run'];
  const remote = !!args['remote'];

  if (args.guide) {
    console.log(GUIDE);
    return;
  }

  if (args.build) {
    const needText = String(args.build);
    if (!needText.trim()) { console.error('错误：--build 需要需求文本'); process.exit(1); }
    // 模板解析：--work-dir 下同名文件优先，其次 skill 内置
    const builtinTemplate = path.join(ROOT, 'prompts', 'req-builder.md');
    const workTemplate = path.join(WORK_ROOT, 'prompts', 'req-builder.md');
    const templateFile = fs.existsSync(workTemplate) ? workTemplate : builtinTemplate;
    if (!fs.existsSync(templateFile)) { console.error('错误：缺少 prompts/req-builder.md'); process.exit(1); }
    const template = fs.readFileSync(templateFile, 'utf8').replace(/^---\r?\nAIGC:[\s\S]*?\r?\n---\r?\n/, '');
    if (template.indexOf('{userNeed}') === -1) { console.error('错误：模板缺少 {userNeed} 占位符'); process.exit(1); }
    const prompt = template.replace(/\{userNeed\}/g, needText);

    // 经适配层调用（无 agent 角色，纯 prompt 调用）
    const cliCfg = adapter.loadCliConfig(ROOT, args['cli-config'] ? path.resolve(args['cli-config']) : null, { adapter: args['adapter'] });
    let runner;
    try { runner = adapter.createRunner(cliCfg); } catch (e) { console.error('错误：' + e.message); process.exit(1); }

    const dynamic = runner.capabilities && runner.capabilities.model ? runner.extraModels() : [];
    const model = args.model || dynamic[0] || null;
    const fallback = runner.supportsFallbackFlag ? (args['fallback-model'] || dynamic[1] || null) : null;

    if (dryRun) {
      console.log('===== 演练模式：将发送给 AI 的完整提示词 =====\n');
      console.log(prompt);
      console.log('\n===== 适配器与模型 =====');
      console.log(`适配器=${runner.name}，命令=${runner.label()}`);
      console.log(`模型=${model || '默认'}${fallback ? `，回退=${fallback}` : ''}`);
      return;
    }

    const probe = runner.probe();
    if ((probe.error || probe.status !== 0) && runner.name !== 'plain') {
      console.error(`错误：agent CLI 不可用（适配器=${runner.name}，命令=${runner.label()}）`);
      process.exit(1);
    }

    log(`[req-builder] 开始整理需求（${needText.length} 字符），适配器=${runner.name}，模型=${model || '默认'}${fallback ? '，回退=' + fallback : ''}`);
    const result = runner.run({
      prompt,
      agentId: null,
      agentDef: null,
      agentsJson: '{}',
      model,
      fallbackModel: fallback,
      cwd: WORK_ROOT,
      timeoutMs: cliCfg.timeoutMs || 600000,
      permissions: cliCfg.permissions,
      outputFormat: cliCfg.outputFormat,
    });
    if (result.status !== 0) {
      const errText = (result.stderr || '').trim() || (result.stdout || '').trim() || ('exit=' + result.status);
      console.error('整理失败：' + errText.slice(0, 2000));
      process.exit(2);
    }
    const outAbs = path.join(WORK_ROOT, 'artifacts', '00-need-refined.md');
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, (result.stdout || '').trim() + '\n');
    log(`[req-builder] 双版本已写入 ${outAbs}`);
    console.log('\n双版本已生成：' + outAbs);
    console.log('请选择版本：node scripts/req-builder.js --select A（精简通用版）或 --select B（高阶顶配版）');
    if (remote) {
      fs.writeFileSync(path.join(WORK_ROOT, 'artifacts', '.req-state.json'), JSON.stringify({ step: 'built', refined: outAbs, updatedAt: new Date().toISOString() }, null, 2));
    }
    return;
  }

  if (args.select) {
    const ver = String(args.select).trim().toUpperCase();
    const autoRun = !!args['auto-run'];
    const refinedPath = path.join(WORK_ROOT, 'artifacts', '00-need-refined.md');
    if (!fs.existsSync(refinedPath)) { console.error('错误：未找到 ' + refinedPath + '，请先运行 --build'); process.exit(1); }
    const content = fs.readFileSync(refinedPath, 'utf8');
    const MARK_A = '===== 版本A：精简通用版 =====';
    const MARK_B = '===== 版本B：高阶顶配版 =====';
    let selected = null;
    if (ver === 'A' || /精简/.test(args.select)) {
      const aIdx = content.indexOf(MARK_A);
      const bIdx = content.indexOf(MARK_B);
      if (aIdx === -1 || bIdx === -1 || bIdx <= aIdx) {
        console.error('错误：无法在文件中定位版本A/B分隔（' + refinedPath + '），请检查生成内容或重新 --build');
        process.exit(1);
      }
      selected = content.slice(aIdx + MARK_A.length, bIdx).trim();
    } else if (ver === 'B' || /高阶/.test(args.select)) {
      const bIdx = content.indexOf(MARK_B);
      if (bIdx === -1) { console.error('错误：未找到版本B分隔（' + refinedPath + '）'); process.exit(1); }
      selected = content.slice(bIdx + MARK_B.length).trim();
    } else {
      console.error('错误：--select 取值应为 A（精简通用版）或 B（高阶顶配版）');
      process.exit(1);
    }
    if (!selected) { console.error('错误：选中版本内容为空'); process.exit(1); }

    const reqAbs = path.join(WORK_ROOT, 'artifacts', '00-requirement.md');
    fs.writeFileSync(reqAbs, '# 需求输入（用户确认版）\n\n' + selected + '\n');
    log(`[req-builder] 已选择版本${ver}，写入 ${reqAbs}`);
    console.log('\n需求已写入：' + reqAbs);
    if (autoRun) {
      const projectName = args['project-name'] || '';
      if (!projectName) { console.error('错误：--auto-run 需要 --project-name <项目名>'); process.exit(1); }
      const runArgs = ['--project-name', projectName];
      for (const k of ['project-root', 'project-dir', 'work-dir', 'from', 'to', 'cli-config', 'adapter', 'remote', 'interactive', 'dry-run']) {
        if (args[k] !== undefined) runArgs.push('--' + k, args[k]);
      }
      log(`[req-builder] 自动续跑流水线：node scripts/run-pipeline.js ${runArgs.join(' ')}`);
      const pipelineScript = path.join(ROOT, 'scripts', 'run-pipeline.js');
      const res = spawnSync(process.execPath, [pipelineScript].concat(runArgs), { encoding: 'utf8', timeout: 0, maxBuffer: 64 * 1024 * 1024, cwd: WORK_ROOT });
      process.stdout.write(res.stdout || '');
      process.stderr.write(res.stderr || '');
      process.exit(res.status || 0);
    }
    console.log('继续执行流水线：node scripts/run-pipeline.js --project-name <项目名> --from 01-product-plan');
    if (remote) {
      fs.writeFileSync(path.join(WORK_ROOT, 'artifacts', '.req-state.json'), JSON.stringify({ step: 'selected', version: ver, requirement: reqAbs, updatedAt: new Date().toISOString() }, null, 2));
    }
    return;
  }

  console.log('用法：');
  console.log('  node scripts/req-builder.js --guide');
  console.log('  node scripts/req-builder.js --build "<需求文本>" [--dry-run] [--remote]');
  console.log('  node scripts/req-builder.js --select A|B [--auto-run --project-name <项目名>] [--remote]');
}

main();
