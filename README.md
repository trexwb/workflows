# CodeBuddy 多 Agent 编排流水线

通过 CodeBuddy Code CLI 的 `--agents` / `--agent` 能力，把"产品规划 → 需求拆解 → 架构设计 → 开发编码 → 代码审查 → 测试 → 部署"拆成多个阶段，每个阶段由**独立的子 Agent** 执行，每个 Agent 可配置**不同的模型**，阶段间通过 `artifacts/` 传递产物。

## Agent Skill 安装与使用（v1.0.0 起，推荐）

本仓库的编排能力已打包为标准 Agent Skill：**`agent-pipeline/`**，支持从 GitHub 直接安装到主流 agent（方式见下）。

- **跨 CLI**：内置适配层自动探测并适配 CodeBuddy / Claude Code / Codex / 任意自定义命令（`config/cli.json`），零 npm 依赖，macOS / Linux / Windows 可用；
- **跨平台默认值**：项目目录默认落在当前目录（`--project-root` 可覆盖），产物/日志写入运行目录或 `--work-dir`，不再依赖 `D:\nodejs\code`；
- **可被程序驱动**：`--remote` 远程确认协议（exit 42 + 状态文件）让 IM 机器人或其他 agent 代你确认/修订，协议详见 `agent-pipeline/references/remote-confirm.md`。

### 从 GitHub 安装（任选其一）

**方式一：skills CLI（Codex / Cursor / Cline / Copilot / Gemini CLI / Claude Code 等通用）**

```bash
npx skills add trexwb/workflows --skill agent-pipeline        # 项目级安装
npx skills add trexwb/workflows --skill agent-pipeline -g     # 全局（~/<agent>/skills/）
```

**方式二：Claude Code 插件市场（本仓库已内置 `.claude-plugin/marketplace.json`）**

```
/plugin marketplace add trexwb/workflows
/plugin install agent-pipeline@trexwb-workflows
```

**方式三：OpenClaw**

```bash
openclaw skills install git:trexwb/workflows@main
```

> skill 位于 `agent-pipeline/` 子目录；若该源未自动发现子目录技能，请用方式四。

**方式四：裸克隆拷贝（通用兑底）**

```bash
git clone https://github.com/trexwb/workflows.git
cp -r workflows/agent-pipeline ~/.claude/skills/      # Claude Code
# 其他 agent：~/.agents/skills/（Codex/Cursor 等通用）或 ~/.openclaw/skills/
```

**Release 资产**：推送 `v*` 标签后，GitHub Actions 自动把 `agent-pipeline.skill`（zip）附到 [Releases](https://github.com/trexwb/workflows/releases)，下载解压到上述 skills 目录即可。

### 本地运行（已克隆本仓库）

```bash
node agent-pipeline/scripts/run-pipeline.js --project-name demo-app --dry-run   # 演练
node agent-pipeline/scripts/run-pipeline.js --project-name demo-app --remote    # 远程确认模式
```

> 下文根目录 `scripts/` 内的脚本是早期 Windows 专用版本，保留作参考；新用法请一律使用 `agent-pipeline/` 内的便携版。

## 编排原理

```
┌─────────────────────────────────────────────────────────────┐
│  run-pipeline.js（编排器）                                    │
│  读取 config/pipeline.json 阶段定义                          │
│  读取 config/agents.json 子代理定义                          │
│  按阶段顺序：组装 prompt → 调 codebuddy CLI → 落盘产物       │
└─────────────────────────────────────────────────────────────┘
        │ 每阶段一次 CLI 调用，参数示例：
        │ codebuddy --agent <角色> --agents '<agents.json>' \
        │          -p "<阶段任务>" --output-format text \
        │          --dangerously-skip-permissions
        ▼
┌─────────────────────────────────────────────────────────────┐
│  CodeBuddy Code CLI                                          │
│  --agent 指定该阶段使用哪个子代理                             │
│  agents.json 中每个子代理带 model / effort / tools           │
│  → 实现"不同 agent 用不同模型"                               │
└─────────────────────────────────────────────────────────────┘
```

- **Agent = 角色 + 系统提示词 + 模型 + 工具白名单**，定义在 `config/agents.json`
- **流水线 = 阶段序列**，定义在 `config/pipeline.json`
- **产物 = 每个阶段写出的文档/代码/报告**，落在 `artifacts/`，供下一阶段作为上下文输入

## 前置条件

1. 安装 CodeBuddy Code CLI：
   ```
   npm install -g @tencent-ai/codebuddy-code
   ```
2. 首次登录：终端执行 `codebuddy`，按提示完成账号登录（后续调用复用登录态）。
3. 确认可用模型：`codebuddy config list` 或交互模式查看；可将 `config/agents.json` 中的 `model` 字段替换为实际可用模型 ID（文档示例：`gpt-5`、`gpt-4`），或使用场景变体 `lite` / `reasoning` / `default`，并可在 CodeBuddy settings 中把变体映射到具体模型。

## 目录结构

```
workflows/
├── README.md
├── config/
│   ├── agents.json          # 子代理定义（角色/提示词/模型/工具）
│   └── pipeline.json        # 流水线阶段定义（顺序/输入/输出）
├── prompts/                 # 各阶段任务提示词模板（支持占位符）
│   ├── 01-product-plan.md
│   ├── 02-requirements.md
│   ├── 03-architecture.md
│   ├── 04-develop.md
│   ├── 05-code-review.md
│   ├── 06-test.md
│   └── 07-deploy.md
├── scripts/
│   └── run-pipeline.js      # 主编排器
├── artifacts/               # 阶段产物（运行时生成，自动创建）
└── logs/                    # 运行日志（运行时生成，自动创建）
```

## 快速开始

> 项目开发目录固定为 `D:\nodejs\code`，每个项目在根目录下建独立子文件夹（`D:\nodejs\code\<项目名>`），由 `--project-name` 自动生成，无需手动传目录。

```bash
# 1. 演练模式：只打印每个阶段将要执行的命令，不真正调用 CLI
node scripts/run-pipeline.js --project-name demo-app --dry-run

# 2. 交互引导模式（推荐）：提出架构 → 产品分析 → 讨论细化需求 → 确认后自动执行
#    01/02 阶段产出后会暂停供你审阅，输入 y 确认，或输入修改意见（!done 结束）让 agent 重跑细化
node scripts/run-pipeline.js --project-name demo-app --interactive

# 3. 只做前置段（产品分析+需求细化），确认后退出，便于单独讨论
node scripts/run-pipeline.js --project-name demo-app --interactive --init-only

# 4. 需求确认后，自动跑完后续阶段（架构→开发→测试→部署）
node scripts/run-pipeline.js --project-name demo-app --from 03-architecture

# 5. 全自动运行（不暂停，适合已确认的需求）
node scripts/run-pipeline.js --project-name demo-app

# 6. 指定阶段范围（如只跑 开发 + 测试）
node scripts/run-pipeline.js --project-name demo-app --from 04-develop --to 06-test

# 7. 远程确认模式（人不在电脑边，由 Marvis 中转确认）
#    01/02 等 confirm 阶段产出后写 .confirm-state.json 并退出（exit 42），
#    由 Marvis 读取状态、转述产物、收集你的确认/意见，再以 --from/--amend 续跑
node scripts/run-pipeline.js --project-name demo-app --remote
```

## 交互引导模式（提出架构 → 讨论 → 自动执行）

这是最贴合"我只提一个想法，之后 agent 自动干活"的用法：

1. **触发产品分析**：运行 `--interactive`，编排器调用 `product-manager` agent 产出 PRD（01 阶段）；
2. **讨论细化需求**：脚本暂停，打印 PRD 供你审阅。输入 `y` 确认继续；或直接输入修改意见（多行以 `!done` 结束），agent 会按意见重新产出 PRD，直到你满意；
3. **确认后自动执行**：确认 02 需求清单后，03-07（架构→开发→审查→测试→部署）全程自动执行，无需再介入。

> 提示：若你更想在 Marvis 对话中讨论需求，可先用 `--init-only` 跑出 PRD/需求清单，把产物交给 Marvis 审阅汇总意见，再用 `--amend "<意见>"` 回灌让 agent 更新产物，最后 `--from 03-architecture` 自动执行。

## 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--project-name` | 项目名，会注入各阶段 prompt 的 `{projectName}` | 必填 |
| `--project-dir` | 项目代码目录（开发/测试/部署阶段的工作目录） | 缺省 `D:\nodejs\code\<project-name>` |
| `--project-root` | 项目根目录（`--project-dir` 未指定时用于拼接子目录） | `D:\nodejs\code` |
| `--from` | 起始阶段 id | `01-product-plan` |
| `--to` | 结束阶段 id | `07-deploy` |
| `--interactive` | 交互模式：`confirm: true` 的阶段产出后暂停审阅/可输入修订意见 | `false` |
| `--remote` | 远程确认模式：`confirm: true` 的阶段产出后写状态文件 `artifacts/.confirm-state.json` 并退出（exit 42），由 Marvis 中转确认/收集意见后续跑 | `false` |
| `--init-only` | 只跑前置段（到最后一个需确认的阶段）即退出 | `false` |
| `--amend "<意见>"` | 把用户修订意见追加进指定阶段（配合 `--from`）重新生成产物 | 无 |
| `--dry-run` | 只打印命令不执行 | `false` |
| `--agents-config` | 子代理配置路径 | `config/agents.json` |
| `--pipeline-config` | 流水线配置路径 | `config/pipeline.json` |

> 在 `config/pipeline.json` 中，阶段加 `"confirm": true` 即表示该阶段产出后需要人工确认（当前 01/02 已标记）。

## 阶段与 Agent / 模型映射（示例）

| 阶段 | 角色 Agent | 模型（示例） | 产物 |
|------|-----------|--------------|------|
| 01 产品规划 | `product-manager` | `lite` | `01-prd.md` 产品需求文档 |
| 02 需求拆解 | `product-manager` | `lite` | `02-tasks.md` 需求清单与任务拆分 |
| 03 架构设计 | `architect` | `reasoning` | `03-architecture.md` 架构与技术选型 |
| 04 开发编码 | `developer` | `default` | 项目源码（写入 project-dir） |
| 05 代码审查 | `code-reviewer` | `reasoning` | `05-review.md` 审查报告 |
| 06 测试 | `tester` | `lite` | `06-test-report.md` 测试用例与结果 |
| 07 部署 | `devops` | `default` | `07-deploy.md` 部署方案/脚本 |

> 模型取值说明：`lite` / `reasoning` / `default` 是 CodeBuddy 的场景变体；也可直接写具体模型 ID（如 `gpt-5`），两者可混用。修改 `config/agents.json` 即可全局调整各角色模型。

## 模型限额自动切换

CodeBuddy 执行过程中可能遇到模型限额/过载（quota / rate limit / 429 等），编排器已内置**双层自动切换**，避免流水线中断：

1. **CLI 层回退**：每次调用主模型时自动带上 `--fallback-model <下一候选>`，CodeBuddy CLI 在主模型过载时自动回退到备用模型；
2. **编排器层切换**：若执行失败且错误信息命中限额/过载关键词，编排器自动用下一个候选模型**重跑当前阶段**，直到成功或候选耗尽；命中关键词包括：`quota` / `rate limit` / `429` / `insufficient` / `overload` / `limit exceeded` / `过载` / `限额` / `超限` / `额度不足`。

### 配置候选模型

在 `config/agents.json` 中为角色添加 `fallbackModels` 数组（已预置空数组占位），**按切换顺序**填入你的自定义模型 ID 或场景变体：

```json
{
  "agents": {
    "architect": {
      "model": "reasoning",
      "fallbackModels": ["gpt-5", "gpt-4"],
      "effort": "high"
    }
  }
}
```

- 候选顺序即切换顺序：主模型 → `fallbackModels[0]` → `fallbackModels[1]` → …，自动去重；
- 也支持在 `config/pipeline.json` 的单个阶段上写 `"fallbackModels": [...]`，优先级高于代理级配置；
- 自定义模型需先在 CodeBuddy 侧确认可用（`codebuddy config list` / settings 中配置的模型变体与 ID）；
- 切换过程会写入运行日志（含切换前后的模型名与命中关键词），便于事后追溯。

## 注意事项

1. **权限参数**：`-p` 单次执行模式下，需要文件修改/命令执行等授权操作时必须带 `--dangerously-skip-permissions`，本编排器默认已带；仅在可信项目中开启。
2. **模型名**：示例中的模型取值是占位，实际以你账号可用的模型为准，运行前请确认。
3. **断点续跑**：失败默认中断（`stop-on-error`）；用 `--from` 可从失败阶段重跑，避免浪费前面已完成的产物。
4. **产物上下文**：每个阶段自动把 `input` 指定的前一阶段产物全文拼进 prompt，确保信息连续。
5. **CLI 未安装**：脚本会检测 `codebuddy` / `cbc` 命令，缺失时给出安装提示。
*（内容由AI生成，仅供参考）*
