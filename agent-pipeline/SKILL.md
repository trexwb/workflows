---
name: agent-pipeline
description: 多 Agent 软件开发流水线编排器。当用户想"从一个想法自动走到部署"、按阶段（产品规划→需求拆解→架构设计→开发编码→代码审查→测试→部署）驱动多个 AI agent 协作、让不同阶段使用不同角色/模型、或需要 GitHub Issue 自动修复循环时使用。通过 CLI 适配层支持 CodeBuddy / Claude Code / Codex / 任意自定义 agent CLI，零 npm 依赖，跨平台（macOS/Linux/Windows）。
---

# 多 Agent 流水线编排（agent-pipeline）

把软件开发拆成多个阶段，每个阶段由**独立子 Agent**（角色 + 系统提示词 + 模型 + 工具白名单）执行，阶段间通过 `artifacts/` 传递产物。编排器负责：组装 prompt → 调用 agent CLI → 落盘产物 → 人工确认/断点续跑/限额自动切换模型。

## 架构

```
run-pipeline.js（编排器）
  读取 config/pipeline.json 阶段定义（id/agent/promptFile/input/output/confirm）
  读取 config/agents.json  子代理定义（角色提示词/模型/工具/回退模型）
  读取 config/cli.json     CLI 适配器选择
        │ 每阶段一次 CLI 调用（经 lib/adapter.js 适配层）
        ▼
任意 agent CLI：codebuddy | claude | codex | plain（自定义命令）
```

- **流水线 = 阶段序列**（`config/pipeline.json`），产物落 `artifacts/` 供后续阶段作为上下文
- **适配器** = 把统一的"prompt + 角色 + 模型"翻译成具体 CLI 参数（`scripts/lib/adapter.js`）
- **限额自动切换**：主模型过载/限额时，先走 CLI 层回退（codebuddy `--fallback-model`），再由编排器换下一候选模型重跑该阶段

## 目录

```
agent-pipeline/
├── SKILL.md                 # 本文件
├── config/
│   ├── cli.json             # CLI 适配器配置（auto 探测顺序 / plain 自定义命令）
│   ├── agents.json          # 6 个子代理：产品经理/架构师/开发/审查/测试/DevOps
│   ├── pipeline.json        # 主流水线 7 阶段（01 产品规划 → 07 部署）
│   ├── issue-pipeline.json  # Issue 修复流 5 阶段（分析→方案→修复→验证→PR 描述）
│   └── github.json          # Issue 监听配置模板
├── scripts/
│   ├── lib/adapter.js       # CLI 适配层（codebuddy/claude/codex/plain）
│   ├── run-pipeline.js      # 主编排器
│   ├── req-builder.js       # 需求构建器（7 维度引导 → AI 双版本 → 选版）
│   ├── init-project.js      # git 拉取项目（优先 DEV 系分支）
│   └── watch-issues.js      # GitHub Issue 监听 → 自动触发修复流
├── prompts/                 # 13 个阶段提示词模板（占位符 {projectName}/{projectDir}/{userNeed}）
├── artifacts/               # 运行时产物
└── logs/                    # 运行日志 pipeline.log
```

## 快速开始

前置：Node.js >= 16；已安装并登录任一受支持 CLI（如 `npm install -g @tencent-ai/codebuddy-code` 后执行 `codebuddy` 完成登录）。

```bash
cd agent-pipeline

# 0. 演练：只打印各阶段命令，不真正执行（同时校验 CLI 可用）
node scripts/run-pipeline.js --project-name demo-app --dry-run

# 1. 交互引导（推荐）：01/02 产出后暂停审阅；y 确认，或输入修改意见（!done 结束）让 agent 重跑
node scripts/run-pipeline.js --project-name demo-app --interactive

# 2. 只跑前置段（产品分析+需求细化），确认后退出
node scripts/run-pipeline.js --project-name demo-app --interactive --init-only

# 3. 需求确认后自动跑完（架构→开发→审查→测试→部署）
node scripts/run-pipeline.js --project-name demo-app --from 03-architecture

# 4. 全自动；或指定阶段范围
node scripts/run-pipeline.js --project-name demo-app
node scripts/run-pipeline.js --project-name demo-app --from 04-develop --to 06-test

# 5. 远程确认：confirm 阶段产出后写 artifacts/.confirm-state.json 并 exit 42，
#    由外部（IM 机器人等）转述产物、收集确认/意见，再以 --from <下一阶段> 或 --from <当前> --amend "<意见>" 续跑
node scripts/run-pipeline.js --project-name demo-app --remote
```

需求尚未想清楚时，先用需求构建器：

```bash
node scripts/req-builder.js --guide                       # 输出 7 维度需求描述引导
node scripts/req-builder.js --build "<你的需求文本>"       # AI 整理为精简版/顶配版双版本
node scripts/req-builder.js --select A                    # 选 A（精简）或 B（顶配）→ 写 artifacts/00-requirement.md
node scripts/req-builder.js --select A --auto-run --project-name demo-app   # 选版后自动续跑流水线
```

已有仓库要接 Issue 自动修复：

```bash
# 编辑 config/github.json（owner/repo/localProjectDir，token 走 GITHUB_TOKEN 环境变量）
node scripts/watch-issues.js --once        # 单轮（配 cron / 计划任务）
node scripts/watch-issues.js --daemon      # 常驻轮询
```

## 参数速查（run-pipeline.js）

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--project-name` | 项目名，注入 prompt 的 `{projectName}` | 必填 |
| `--project-dir` | 项目代码目录（开发/测试/部署的工作目录） | `<project-root>/<project-name>` |
| `--project-root` | 项目根目录 | 当前目录 |
| `--work-dir` | artifacts/logs 与自定义模板/配置的根 | skill 根目录 |
| `--from` / `--to` | 起止阶段 id | 首/末阶段 |
| `--interactive` | confirm 阶段产出后暂停审阅，可回灌修订意见 | false |
| `--remote` | confirm 阶段产出后写状态文件并 exit 42 | false |
| `--init-only` | 跑到最后一个需确认的阶段即退出 | false |
| `--amend "<意见>"` | 修订意见追加进 `--from` 阶段重跑 | 无 |
| `--dry-run` | 只打印命令不执行 | false |
| `--pipeline-config` / `--agents-config` / `--cli-config` | 配置路径覆盖 | config/ 下默认值 |
| `--adapter` | 强制适配器（codebuddy/claude/codex/plain） | auto |

## CLI 适配层

选择顺序：环境变量 `AGENT_PIPELINE_ADAPTER` > `cli.json` 的 `adapter` > `autoDetect` 依次探测。

| 适配器 | 角色注入方式 | 模型切换 | 说明 |
|--------|--------------|----------|------|
| `codebuddy` | `--agent` + `--agents`（原生多代理） | CLI 层 `--fallback-model` + 编排器重跑 | 工具白名单/effort/maxTurns 生效；`~/.codebuddy/models.json` 自定义模型自动进候选 |
| `claude` | `--append-system-prompt` | 编排器重跑 | Claude Code CLI |
| `codex` | 角色提示词拼入 prompt 头 | 编排器重跑 | `codex exec --full-auto` |
| `plain` | 角色提示词拼入 prompt 头 | 不支持 | 任意命令：在 `cli.json` 填 `plain.command`（如 `"aider --message"`），`promptMode: arg|stdin` |

环境变量：`CODE_BUDDY_CMD` / `CLAUDE_CLI_CMD` / `CODEX_CLI_CMD` / `AGENT_CLI_CMD` 可覆盖各命令路径。

## 定制与扩展

- **改阶段**：编辑 `config/pipeline.json`——增删 `stages` 项；`confirm: true` 标记需人工确认；`input` 指向前序产物；`output: null` 表示不落盘（如开发阶段直接写代码）。
- **改角色/模型**：编辑 `config/agents.json`——`model` 填 `auto`/具体模型 ID/场景变体（lite/reasoning/default，CodeBuddy 支持）；`fallbackModels` 按顺序作为限额回退候选；阶段级 `model`/`fallbackModels` 优先于代理级。
- **改提示词**：编辑 `prompts/*.md`，支持 `{projectName}`/`{projectDir}` 占位符。把同名文件放 `--work-dir` 下可覆盖内置模板。
- **换 CLI**：改 `config/cli.json` 的 `adapter`，或 `AGENT_PIPELINE_ADAPTER=plain` + `plain.command`。

## 注意事项

1. **权限**：`permissions: skip`（默认）会携带跳过权限确认的参数（如 `--dangerously-skip-permissions` / `--full-auto`），仅在可信项目使用；改 `cli.json` 为 `ask` 可关闭。
2. **断点续跑**：阶段失败 exit 2，用 `--from <失败阶段>` 续跑，前序产物不浪费。
3. **产物上下文**：每阶段自动把 `input` 指定的产物全文拼进 prompt；缺失仅告警不中断。
4. **Windows**：npm 全局 `.cmd` 包装器会自动改为 node 直跑 JS 入口，规避 spawn EINVAL 与 shell 转义问题。
5. **退出码**：0 成功；1 配置/CLI 错误；2 阶段执行失败；42 远程确认挂起（REMOTE_CONFIRM_NEEDED）。
