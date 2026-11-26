# agent-pipeline

多 Agent 软件开发流水线编排器，目标是帮助用户**「从一个想法自动推进到可交付代码」**或**「一条修复需求自动推进到可发布修复」**。默认由独立项目经理负责启动派活、生成任务书、逐阶段验收、返工/退回上游、最终验收与人工升级；专业角色仍按固定阶段交付：开发七阶段（产品规划 → 需求拆解 → 架构设计 → 开发编码 → 代码审查 → 测试 → 部署），修复五阶段（分析 → 方案 → 修复 → 验证 → PR 描述，支持手动需求与 GitHub Issue）。专业角色通过 REPORT 反馈证据，项目经理通过 DECISION 控制路由，只有业务范围、生产发布、不可逆操作、授权或证据冲突等无权决策事项才升级人工。每个角色自带持久知识库、过程记忆与动态委托能力（项目经理门禁禁止委托）；阶段间用 `artifacts/` 传递产物，支持远程人工恢复、断点续跑、限额自动切换模型，并附带需求构建器。最终验收表示可交付/待部署，不表示已上线。

遵循 **Agent Skills 开放标准**，一份 `SKILL.md` 可部署到 **WorkBuddy / CodeBuddy / zCode / Qoder / Marvis / Claude Code / Codex** 及任意自定义 agent CLI。编排器本身是纯 Node.js 脚本（**Node.js >= 18、零 npm 依赖、macOS / Linux / Windows 通用**），**不调用任何 agent CLI**，AI 能力来自宿主自己的派发能力。技能的完整行为契约（目标、输入、工作流与角色、执行步骤、输出格式、约束）见 [`SKILL.md` 的「技能契约」](SKILL.md#技能契约)。

当前版本：**2.0.0**（唯一权威来源：`meta.json` 的 `version`；用 `node scripts/version.js` 管理，历史见 `CHANGELOG.md`）。

**内容导航**：[快速开始](#1-快速开始) · [安装](#2-安装到五个宿主) · [宿主派发](#3-宿主派发不调用任何-cli) · [运行流水线](#4-运行流水线) · [辅助入口](#5-三个辅助入口) · [定制](#6-定制不改动安装目录) · [故障排查](#7-故障排查) · [约定与退出码](#8-运行时约定与退出码) · [目录](#9-目录结构) · [版本管理](#10-版本管理与迭代) · [文档索引](#11-文档索引)

---

## 1. 快速开始

前置：Node.js >= 18；**无需安装或登录任何 agent CLI**。

### 安装（三选一）

```bash
# 方式 A：一键远程安装（推荐，无需 clone 仓库、无需 Node.js）
bash <(curl -fsSL https://raw.githubusercontent.com/trexwb/agent-pipeline/main/scripts/install-remote.sh)

# 方式 B：从 GitHub 远程安装（需要 Node.js >= 18）
node scripts/install.js --from-github

# 方式 C：本地源码安装（已 clone 仓库时）
node scripts/install.js --platform auto --scope user
```

### 运行

```bash
# 1) 演练：只校验阶段链与提示词配置，不出工单、不派发
node scripts/run-pipeline.js --project-name demo-app --project-root ./pipeline-run --work-dir ./pipeline-run --dry-run

# 2) 正式运行：exit 3 = 有工单待宿主执行，回写后重跑；exit 0 = 完成
node scripts/run-pipeline.js --project-name demo-app --project-root ./pipeline-run --work-dir ./pipeline-run
```

`--project-root` 决定代码目录（默认 `<project-root>/<project-name>`），`--work-dir` 决定产物与日志；两者一起指定可把所有输出集中在一个目录、不污染当前工作区。

正式运行时编排器把阶段任务落成工单并以退出码 3 交还执行权，宿主派子 Agent 执行后回写、重跑，直到 exit 0 或 42。安装后重启宿主或执行 `/skills reload`，在对话里说「帮我把这个需求自动编排到开发完成」即可触发 skill。

> 在 skill 目录外执行时，把 `scripts/...` 换成绝对路径；所有产物建议用 `--work-dir` 明确指定，避免写进只读的安装目录。

---

## 2. 安装到五个宿主

安装目录名固定为 `agent-pipeline`，与 `SKILL.md` frontmatter 的 `name` 一致（zCode 强制要求小写 kebab-case 且与目录名相同）。

| 宿主 | 用户级目录 | 项目级目录 | 安装时写入的元数据 |
|------|-----------|-----------|-------------------|
| WorkBuddy | `~/.workbuddy/skills/agent-pipeline/` | `.workbuddy/skills/agent-pipeline/` | `meta.json`、`_skillhub_meta.json`、`metadata.json` |
| CodeBuddy | `~/.codebuddy/skills/agent-pipeline/` | `.codebuddy/skills/agent-pipeline/` | 同上 |
| zCode | `~/.zcode/skills/agent-pipeline/` | `.zcode/skills/agent-pipeline/` | 同上（多余文件会被忽略） |
| Marvis | `~/.marvis/skills/custom/agent-pipeline/` | 不支持项目级 | 同上，`meta.json` 为必需项 |
| Qoder | `~/.qoder/skills/agent-pipeline/`；国内版 `~/.qoder-cn/skills/agent-pipeline/` | `.qoder/skills/agent-pipeline/` | 同上 |
| 通用 | `~/.agents/skills/agent-pipeline/` | `.agents/skills/agent-pipeline/` | 跨工具发现点，见下方 `common` |

### 安装器参数

| 参数 | 说明 | 默认 |
|------|------|------|
| `--platform <列表>` | `workbuddy` / `codebuddy` / `zcode` / `marvis` / `qoder` / `common` / `auto` / `all`，逗号分隔可组合 | `auto` |
| `--scope <范围>` | `user` / `project` / `both` | `user` |
| `--project-root <路径>` | 项目级安装的根目录 | 当前目录 |
| `--link` | 建立目录软链而非复制（开发模式，改源码即时生效） | 关闭 |
| `--force` | 覆盖已存在的同名安装 | 关闭 |
| `--uninstall` | 卸载（仅删除含本 skill `SKILL.md` 的目录） | 关闭 |
| `--from-github` | 从 GitHub Releases 下载最新版本安装（无需 clone 源码） | 关闭 |
| `--version <x.y.z>` | 与 `--from-github` 配合，下载指定版本（默认获取最新版本） | — |
| `--dry-run` | 只打印计划，不写任何文件 | 关闭 |

- `auto` = 只安装到本机已检测到的宿主配置目录；`all` = 五个主宿主（不含 `common`）；`common` = 通用 `.agents/skills`，一份安装可被 zCode / Codex / Cursor 等共同发现。
- Qoder 会自动识别 `~/.qoder` 与 `~/.qoder-cn`，两者都存在时各装一份。
- Marvis 自建 skill 必须放 `skills/custom/`（`skills/market/` 留给市场包），且无项目级目录。
- 项目级目标不能落在 skill 源码目录内，安装器会直接拒绝并提示换 `--project-root`。

### 常用安装命令

```bash
# 本地源码安装
node scripts/install.js --platform all,common --scope user          # 全部宿主 + 通用发现点
node scripts/install.js --platform all --scope project --project-root /path/to/repo   # 团队共享
node scripts/install.js --platform auto --scope user --link         # 开发模式软链
node scripts/install.js --platform auto --scope user --force        # 升级覆盖旧版本
node scripts/install.js --platform all,common --scope user --uninstall

# 从 GitHub 远程安装（无需 clone 源码）
node scripts/install.js --from-github                               # 下载最新版本安装
node scripts/install.js --from-github --version 1.0.0               # 下载指定版本
node scripts/install.js --from-github --platform auto --scope user  # 远程安装到指定宿主
```

### 安装验收

```bash
node scripts/install.js --dry-run                                   # 目标路径是否正确
node scripts/run-pipeline.js --project-name smoke --project-root /tmp/ap-smoke --work-dir /tmp/ap-smoke --dry-run
```

1. 每个目标目录存在 `SKILL.md`，`name: agent-pipeline` 且与目录名一致；
2. Marvis 目标存在 `meta.json`，WorkBuddy / CodeBuddy 目标存在 `_skillhub_meta.json`；
3. `artifacts/`、`logs/`、`data/` 只出现在 `--work-dir`，安装目录保持干净。

各宿主的发现优先级、frontmatter 差异与已知限制见 [`references/platform-compat.md`](references/platform-compat.md)。

---

## GitHub Release 与远程安装

本技能通过 GitHub Actions 实现自动打包与发布：

### 发布流程

1. **打 tag**：在源码目录执行 `git tag v1.0.0 && git push origin v1.0.0`
2. **自动打包**：GitHub Actions 触发 `.github/workflows/release.yml`，自动：
   - 校验 `meta.json` 版本号与 tag 一致
   - 打包 `agent-pipeline-1.0.0.zip`（排除 `.git/`、`node_modules/` 等）
   - 创建 GitHub Release 并上传 zip
3. **用户安装**：
   - **方式 A（推荐，一键安装）**：`bash <(curl -fsSL https://raw.githubusercontent.com/trexwb/agent-pipeline/main/scripts/install-remote.sh)`
   - 方式 B（Node 安装）：`node scripts/install.js --from-github --version 1.0.0`
   - 方式 C（手动）：下载 zip → 解压 → `node scripts/install.js --platform auto --scope user`

### 远程安装原理

`install.js --from-github` 会：
1. 从 GitHub API 获取最新版本号（或使用 `--version` 指定）
2. 下载对应 zip 到临时目录
3. 解压后执行常规安装流程
4. 安装完成后自动清理临时文件

### 一键远程安装（推荐）

**无需 clone 仓库、无需 Node.js**，员工只需复制粘贴一行命令：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/trexwb/agent-pipeline/main/scripts/install-remote.sh)
```

选项：
```bash
# 安装指定版本
bash <(curl -fsSL https://raw.githubusercontent.com/trexwb/agent-pipeline/main/scripts/install-remote.sh) -- --version 1.0.0

# 安装到所有宿主
bash <(curl -fsSL https://raw.githubusercontent.com/trexwb/agent-pipeline/main/scripts/install-remote.sh) -- --platform all

# 预览安装计划（不执行）
bash <(curl -fsSL https://raw.githubusercontent.com/trexwb/agent-pipeline/main/scripts/install-remote.sh) -- --dry-run

# 覆盖已存在的安装
bash <(curl -fsSL https://raw.githubusercontent.com/trexwb/agent-pipeline/main/scripts/install-remote.sh) -- --force

# 卸载
bash <(curl -fsSL https://raw.githubusercontent.com/trexwb/agent-pipeline/main/scripts/install-remote.sh) -- --uninstall
```

脚本自动检测本机已安装的宿主（Qoder / WorkBuddy / CodeBuddy / zCode / Marvis），只安装到存在的目录。

---

## 3. 宿主派发（不调用任何 CLI）

流水线**不启动任何外部进程**。`scripts/lib/host-adapter.js` 只做四件事：出工单、交还执行权、接收回写、复用结果。谁执行由宿主决定（Marvis 用 `dispatch_task` 派子 Agent，其它宿主用自身派发能力写完文件回写即可）。

| 概念 | 落点 | 说明 |
|------|------|------|
| 工单 | `handoff/orders/<key>.order.md` | 阶段角色、提示词、上下文、证据要求全文；`<key>` = `阶段id--角色id` |
| 队列 | `handoff/queue.json` | `pending`（当前待办，含 `key` / `promptHash` / `stageId`）与 `history` |
| 回写 | `handoff/results/<key>.result.md` | 宿主把子 Agent 输出写到文件后 submit 到此 |
| 归档 | `handoff/done/` | 消费后成对的 `.order.md` / `.result.md` |
| 缓存 | `handoff/executions/` | 阶段结果缓存，重跑直接重放，不重复派发 |

一次推进的完整节奏：

```bash
# 1) 跑编排器：要么推进一个阶段并 exit 3，要么全部完成 exit 0
node scripts/run-pipeline.js --project-name demo-app --work-dir ./run

# 2) 查看待办工单正文（交给宿主子 Agent 执行）
node scripts/host-queue.js --work-dir ./run status

# 3) 把子 Agent 输出写进文件后回写
node scripts/host-queue.js --work-dir ./run submit --file ./out.md

# 4) 重跑第 1 步，循环直到 exit 0 / 42
```

工单去重与安全：同 `key` 且 `promptHash` 未变时只等待、不重复出单；阶段已推进导致工单过期，或同阶段任务正文已改，旧工单会被标记 `superseded` 并归档，避免结果串用。`handoff/queue.json` 的 `keepDone`（默认 40）控制归档保留量。

配置（`config/host.json`，可复制到 `--work-dir/config/host.json` 覆盖，不触碰安装目录）：

```json
{
  "mode": "host",
  "orderDir": "handoff/orders",
  "resultDir": "handoff/results",
  "doneDir": "handoff/done",
  "queueFile": "handoff/queue.json",
  "keepDone": 40
}
```

> 模型偏好（`config/agents.json` 的 `model` / `fallbackModels`）只作为工单里的声明传给宿主，编排器不做限额换号；`auto` 表示交给宿主自行选择。离线自测可用 `--host-script <js>` 注入进程内响应器（导出 `respond(prompt)` 返回正文），无需任何外部工具。

---

## 4. 运行流水线

```bash
# 默认项目经理模式，或明确指定阶段范围
node scripts/run-pipeline.js --project-name demo-app --work-dir ./run
node scripts/run-pipeline.js --project-name demo-app --from 04-develop --to 06-test --work-dir ./run

# 只跑前置范围后退出；再次不带 --from 运行会从状态记录的下一阶段恢复
node scripts/run-pipeline.js --project-name demo-app --to 02-requirements --work-dir ./run

# 阶段失败 exit 2 后断点续跑；带修改意见重跑某阶段
node scripts/run-pipeline.js --project-name demo-app --from 04-develop --work-dir ./run
node scripts/run-pipeline.js --project-name demo-app --from 04-develop --amend "补充登录校验" --work-dir ./run

# 项目经理升级人工退出 42 后，按决策包 ID 恢复（不要重复传 --requirement/--from）
node scripts/run-pipeline.js --project-name demo-app --work-dir ./run \
  --resume-human human-123 --amend "人工决定：拒绝风险豁免并修复 C1"

# 功能修复：现有功能故障/报错/行为不符，直接描述问题走修复流水线（见下节）
node scripts/run-pipeline.js --project-name demo-app --project-dir ./demo-app \
  --pipeline fix --requirement "登录页在 Safari 下提交报错 XXX" --work-dir ./run-fix
```

### 参数速查（`run-pipeline.js`）

| 参数 | 说明 | 默认 |
|------|------|------|
| `--project-name` | 必填，注入 prompt 的 `{projectName}` | — |
| `--project-dir` | 代码目录（开发/测试/部署阶段的工作目录） | `<project-root>/<project-name>` |
| `--project-root` | 项目根目录 | 当前目录 |
| `--work-dir` | `artifacts/`、`logs/`、状态文件与自定义模板/配置的根 | 当前目录 |
| `--pipeline feature\|fix` | 流水线预设：开发 7 阶段 / 修复 5 阶段，与 `--pipeline-config` 互斥 | `feature` |
| `--requirement "<文本>"` | 需求原文写入 `artifacts/00-requirement.md`，作首阶段输入（两条流水线通用） | — |
| `--from` / `--to` | 起止阶段 id | 首 / 末阶段 |
| `--interactive` | 项目经理升级人工时终端应答；旧配置用于 confirm 阶段审阅 | 关闭 |
| `--remote` | 旧配置 confirm 阶段写 `.confirm-state.json` 并 exit 42；项目经理升级始终支持非交互退出 | 关闭 |
| `--init-only` | 旧配置到最后一个 confirm 阶段；项目经理模式到本次范围内最后一个 confirm 阶段 | 关闭 |
| `--amend "<意见>"` | 追加进 `--from` 阶段；或作为 `--resume-human` 的人工决策原文 | — |
| `--resume-human <id>` | 按 `pm-escalation.json` 的 decisionId 恢复升级，必须同时提供 `--amend` | — |
| `--fix-rounds <n>` | 仅旧配置修复回炉轮数，`0`=关闭；项目经理模式使用返工预算 | 修复流默认 `2` |
| `--knowledge-dir <dir>` | 角色知识库目录（注入历史经验 + 沉淀新知识） | `<work-dir>/knowledge` |
| `--no-knowledge` | 关闭角色知识库（不注入、不沉淀） | 关闭 |
| `--no-memory` | 关闭角色记忆（执行摘要/交接便签/用户修订入记忆） | 关闭 |
| `--no-delegate` | 关闭动态委托（角色声明换更合适角色执行本阶段） | 关闭 |
| `--dry-run` | 只校验阶段链与提示词，不出工单 | 关闭 |
| `--pipeline-config` / `--agents-config` / `--host-config` | 配置路径覆盖 | `config/` 下默认值 |
| `--host-script <js>` | 进程内响应器（导出 `respond(prompt)`）替代宿主派发，离线自测用 | 无 |
| `--timeout-ms` | 单阶段执行超时（毫秒） | `config/host.json` 的 `timeoutMs` |

### 阶段与产物

开发流保留 7 个专业阶段、7 个专业角色，另设独立 `project-manager` 控制角色。正常推进不得跳过专业阶段；项目经理验收不通过时，只能 `REWORK` 当前阶段或 `RETURN_UPSTREAM` 退回更早阶段。`--from` / `--to` 仅用于失败续跑、部分执行或用户明确指定的范围。

| 序号·阶段 | 阶段 id | 当前执行角色 | agent id | 产物 | 旧配置需确认 |
|-----------|---------|--------------|----------|------|--------|
| 1 产品规划 | `01-product-plan` | 产品规划引导师 | `product-manager` | `artifacts/01-prd.md` | 是 |
| 2 需求拆解 | `02-requirements` | 需求拆解与功能点呈现专员 | `requirement-analyst` | `artifacts/02-tasks.md` | 是 |
| 3 架构设计 | `03-architecture` | 架构师 | `architect` | `artifacts/03-architecture.md` | 否 |
| 4 开发编码 | `04-develop` | 全栈开发工程师 | `developer` | `artifacts/04-implementation.md`（代码写入 `--project-dir`） | 否 |
| 5 代码审查 | `05-code-review` | 代码审查工程师 | `code-reviewer` | `artifacts/05-review.md` | 否 |
| 6 测试 | `06-test` | 测试工程师 | `tester` | `artifacts/06-test-report.md` | 否 |
| 7 部署 | `07-deploy` | 运维工程师 | `devops` | `artifacts/07-deploy.md` | 否 |

`artifacts/00-requirement.md` 是可选的需求输入（由需求构建器或 `--requirement` 生成），缺失时仅告警。每阶段会把 `input` 列出的前序产物全文拼进 prompt；提示词模板要求子 Agent 把文档正文输出到 stdout，由编排器统一落盘，禁止子 Agent 自行写产物文件。信息缺失或需求歧义时的确认规则见 [`SKILL.md` 的「约束」](SKILL.md#约束)。

### 项目经理模式（默认）

项目经理与 `product-manager` 是两个角色：前者控制交付，后者只负责 PRD。项目经理默认工具白名单为只读，不代替开发、测试、审查或运维角色提供证据；宿主不支持工具白名单时，由提示词约束同一边界。

```text
用户需求
  → 项目经理 dispatch：生成首阶段任务书
  → 专业角色执行：正文 + REPORT（证据/问题/未验证/待决策）
  → 项目经理 review：PROCEED / REWORK / RETURN_UPSTREAM / ESCALATE / COMPLETE
  → 编排器执行路由：派活、返工、失效下游产物、暂停人工或生成验收单
```

| 路由 | 编排器动作 |
|------|-----------|
| `PROCEED` | 记录当前阶段通过，只为紧邻下一阶段写入任务书 |
| `REWORK` | 重跑当前阶段，消耗单阶段与总返工预算 |
| `RETURN_UPSTREAM` | 退回更早阶段，目标及下游产物、已完成验收结论失效 |
| `ESCALATE` | 写人工升级包，非交互退出 42；恢复时保留状态、历史与已花预算 |
| `COMPLETE` | 仅完整流水线最后阶段可用，生成 `99-acceptance.md`，状态为可交付/待部署 |

默认预算：单阶段最多返工 2 次、总返工 6 次；预算耗尽会升级人工。开发流成功路径约 15 轮宿主派发，修复流约 11 轮，返工/升级会增加轮次。缺少 REPORT 不得放行，最后阶段不得用 PROCEED 冒充完成。

管理产物：

| 文件 | 用途 |
|------|------|
| `artifacts/pm-handoff.md` | 当前目标阶段任务书 |
| `artifacts/pm-decisions.md` | 派活、验收、返工与升级决策日志 |
| `artifacts/pm-project-state.json` | 原子持久化状态、已完成阶段、失效产物、返工预算、历史与 pending |
| `artifacts/pm-escalation.json` | 人工决策包；恢复需要 `pending.decisionId` |
| `artifacts/99-acceptance.md` | 最终验收结论与剩余风险 |

人工升级退出 42 后读取 `pm-escalation.json`，转述问题、原因、选项、推荐、影响和证据，再执行：

```bash
node scripts/run-pipeline.js --project-name demo-app --work-dir ./run \
  --resume-human <decisionId> --amend "<人工决策原文>"
```

恢复时不要重复传 `--requirement` 或显式 `--from`，否则会开启新管理运行。`--interactive` 可在终端选择推荐方案、输入自定义决定或停止项目。

### 功能修复流水线（`--pipeline fix`）

现有功能出现故障、报错、行为与预期不符时，不必提 GitHub Issue 等监听，直接描述问题走修复 5 阶段（配置 `config/issue-pipeline.json`）：

```bash
# 默认由项目经理验收修复方案；需要人工决策时才暂停
node scripts/run-pipeline.js --project-name my-app --project-dir ./my-app \
  --pipeline fix --requirement "导出 CSV 在 Windows 下中文乱码，复现步骤……" \
  --work-dir ./run-fix

# 完整修复流；VERDICT: FAIL 由项目经理决定返工/退回上游，不自动跳过验证
node scripts/run-pipeline.js --project-name my-app --project-dir ./my-app \
  --pipeline fix --requirement "……" --work-dir ./run-fix
```

| 序号·阶段 | 阶段 id | 当前执行角色 | agent id | 产物 | 旧配置需确认 |
|-----------|---------|--------------|----------|------|--------|
| 1 修复需求分析 | `01-issue-analysis` | 代码审查工程师 | `code-reviewer` | `artifacts/issue-analysis.md` | 否 |
| 2 修复方案设计 | `02-fix-plan` | 架构师 | `architect` | `artifacts/issue-fix-plan.md` | 是 |
| 3 开发修复 | `03-fix-dev` | 全栈开发工程师 | `developer` | `artifacts/issue-fix-done.md`（代码写入 `--project-dir`） | 否 |
| 4 修复验证 | `04-fix-test` | 测试工程师 | `tester` | `artifacts/issue-test-report.md`（末行 `VERDICT: PASS\|FAIL`） | 否 |
| 5 PR 描述 | `05-pr-summary` | 运维工程师 | `devops` | `artifacts/issue-pr.md` | 否 |

- 需求原文由 `--requirement` 写入 `artifacts/00-requirement.md`，作为阶段 1 的输入；`--from <阶段> --amend "<意见>"` 断点重跑同样适用。
- **项目经理验收**：阶段 4 报告末行必须保留 `VERDICT: PASS|FAIL`。FAIL、缺少 REPORT 或证据不足时，项目经理可 `REWORK` 开发修复、`RETURN_UPSTREAM` 修正分析/方案，或在超出权限时 `ESCALATE`；不得直接完成。
- **旧配置自动回炉**：仅当 `projectManager` 缺失或 `enabled: false` 时，命中 `VERDICT: FAIL` 且轮数未用尽就回阶段 3 重修（`retry` 配置，`--fix-rounds` 覆盖，默认 2，`0` 关闭）；缺少 VERDICT 或轮数用尽均失败退出。

### 角色知识库、记忆与动态委托

每个专业角色默认同时具备三种持久能力；项目经理也使用知识库与记忆，但验收门禁禁止动态委托。同一工作目录下的重复运行持续积累：

| 能力 | 存什么 | 位置 | 开关 |
|------|--------|------|------|
| **知识库** | 跨任务可复用的事实经验（项目约定、踩坑解法、有效命令） | `knowledge/<agent-id>.md` | `--no-knowledge`；角色 `knowledge: false` |
| **记忆** | 任务过程上下文（执行摘要、交接便签、用户修订意见） | `memory/<agent-id>.md` + `memory/handoffs.md` | `--no-memory`；角色 `memory: false` |
| **动态委托** | 角色间换手：本阶段更适合谁就由谁执行 | （运行时机制，无文件） | `--no-delegate` |

**知识库**：执行时把该角色历史知识（末尾最近 4000 字符）拼进 prompt；角色在回复末尾以 `KNOWLEDGE APPEND` 标记段输出新经验，编排器抽取沉淀、产物自动剥离。`--knowledge-dir` 指向固定目录可跨项目共享。

**记忆**：执行阶段时自动带出 `[工作记忆·本阶段]`（该角色上次执行本阶段的摘要、用户曾给的修订意见）与 `[工作记忆·前序阶段交接]`（其他角色写给后续阶段的便签）——断点续跑、`--from` 重跑、修订后重跑不再失忆。沉淀双通道：角色输出 `MEMORY APPEND` 段（`summary:` 执行摘要 → `memory/<agent-id>.md`；`handoff:` 交接提示 → `memory/handoffs.md`）；**用户修订意见（交互 amend / `--amend` / 回炉报告）由编排器自动记入记忆**，重跑同阶段自动提醒「用户曾要求…」。

```text
阶段 N 执行                             阶段 N 完成
prompt ←─ memory/<角色>.md(本阶段历史)    MEMORY 段 summary/handoff
        ←─ memory/handoffs.md(前序交接)      ↓ 抽取沉淀
        ←─ knowledge/<角色>.md(历史经验)    memory/<角色>.md + handoffs.md
                                           (供阶段 N+1 注入)
用户 amend 意见 ──编排器自动──→ memory/<角色>.md
```

**动态委托**：角色执行中发现本阶段更适合其他角色时，回复末尾输出：

```text
===== DELEGATE =====
target: architect
reason: 本需求实为数据库 schema 调整，超出产品规划专长
handoff: 用户要求保留存量表结构，初步分析见正文
===== DELEGATE END =====
```

编排器自动换 `target` 角色重跑本阶段：原角色的初步产出与交接说明作为上下文带入，知识/记忆沉淀与产物归属最终执行者，日志记录委托链。边界：只能委托给 `agents.json` 内角色；每阶段最多换一次执行角色（防 A→B→A 循环）；**只换执行者，不改变阶段顺序、产物路径与验收要求**。

### 人工升级与旧版确认机制

- **项目经理模式（默认）**：`--interactive` 在终端应答升级；非交互模式（包括 `--remote`）写 `artifacts/pm-escalation.json`、打印 `HUMAN_DECISION_NEEDED`、退出 42。外部驱动方用 `--resume-human <decisionId> --amend "<人工决定>"` 恢复。
- **旧配置**（`projectManager` 缺失或 `enabled: false`）：`--interactive` 在 confirm 阶段终端审阅；`--remote` 写 `artifacts/.confirm-state.json`、打印 `REMOTE_CONFIRM_NEEDED`、退出 42，外部按「确认 → `--from <nextStageId>`；修改 → `--from <stageId> --amend`」续跑。
- 两种协议详情见 [`references/remote-confirm.md`](references/remote-confirm.md)。GitHub Issue 监听器将项目经理升级记录为 `awaiting-human`，不修改远端 Issue 状态。

---

## 5. 三个辅助入口

### 需求构建器（需求还模糊时）

```bash
node scripts/req-builder.js --guide                                  # 7 维度需求引导
node scripts/req-builder.js --build "<需求文本>" --work-dir ./run     # AI 生成精简版 A / 顶配版 B
node scripts/req-builder.js --select A --work-dir ./run              # 写入 artifacts/00-requirement.md
node scripts/req-builder.js --select A --auto-run --project-name demo-app --work-dir ./run --interactive
```

`--auto-run` 会把 `project-root` / `project-dir` / `work-dir` / `from` / `to` / `host-config` / `remote` / `interactive` 等参数透传给 `run-pipeline.js`。`--remote` 会额外写 `artifacts/.req-state.json`。

### GitHub Issue 自动修复

先编辑 `config/github.json`（或设置 `GITHUB_TOKEN` 环境变量）：

| 字段 | 说明 |
|------|------|
| `owner` / `repo` | 仓库坐标 |
| `token` | PAT，留空时读 `GITHUB_TOKEN` |
| `localProjectDir` | 本地仓库路径（必须已存在） |
| `intervalMs` | 轮询间隔，默认 300000 |
| `pipelineConfig` | 修复流水线配置，默认 `config/issue-pipeline.json`（非默认值时以 `--pipeline-config` 传入） |
| `processExisting` | 是否处理存量 Issue，默认 `false` |
| `maxFixRounds` | 仅旧配置验证未通过时自动回炉的最大轮数（透传 `--fix-rounds`），默认 2 |

```bash
export GITHUB_TOKEN=ghp_xxx
node scripts/watch-issues.js --once --work-dir ./run       # 单轮，适合 cron / 计划任务
node scripts/watch-issues.js --work-dir ./run              # 默认常驻轮询（不带 --once 即常驻）
```

首次运行只建立基线、不处理存量 Issue。每个新 Issue 触发一次修复流水线（`--pipeline fix`，Issue 原文经 `--requirement` 注入）：Issue 分析 → 修复方案 → 修复开发 → 修复验证 → PR 描述；默认由项目经理验收，`VERDICT: FAIL` 不得直接放行，旧配置才按 `maxFixRounds` 自动回炉。项目经理需要人工时结果为 `awaiting-human`，不会修改远端 Issue 状态。**每个 Issue 的产物写在自己的 `<work-dir>/issue-<N>/artifacts/` 下**，互不覆盖；监听状态文件 `data/processed-issues.json` 仍在 `--work-dir` 根。

### 拉取项目代码

```bash
node scripts/init-project.js --url git@github.com:org/repo.git --name demo-app --root /path/to/work --dry-run
node scripts/init-project.js --url git@github.com:org/repo.git --name demo-app --root /path/to/work
```

支持 `--dir` 指定目标目录、`--branch` 指定分支；未指定分支时优先 `DEV` / `dev` / `develop`。已有 git 仓库则 `fetch + checkout`，否则 `clone --single-branch`。

---

## 6. 定制（不改动安装目录）

市场安装的 skill 目录通常是只读的。编排器按「**`--work-dir` 下的同名文件优先 → skill 内置文件兜底**」解析模板与配置：

```text
<work-dir>/
├── config/
│   ├── pipeline.json        # 增删阶段、调整 confirm / input / output
│   ├── agents.json          # 角色提示词、模型、fallbackModels、knowledge 开关
│   └── host.json            # 宿主派发目录、队列、超时
├── prompts/
│   └── 04-develop.md        # 覆盖单个阶段提示词
├── knowledge/               # 角色知识库（追加式，可人工修剪）
│   └── developer.md
├── memory/                  # 角色记忆（任务过程上下文）
│   ├── developer.md         #   执行摘要 + 用户修订记录（按阶段分段）
│   └── handoffs.md          #   阶段间交接便签
└── artifacts/               # 产物
```

也可用 `--pipeline-config` / `--agents-config` / `--host-config` 直接指向自定义文件。提示词支持 `{projectName}` / `{projectDir}` / `{userNeed}` 占位符；阶段级 `model` / `fallbackModels` 优先于代理级配置。

> 编排器不 spawn 任何外部命令，因此没有 CLI 权限参数可配；阶段实际权限由宿主派发的子 Agent 决定。

---

## 7. 故障排查

| 现象 | 原因与处理 |
|------|-----------|
| 退出码一直是 3、阶段不推进 | 有工单未回写。`host-queue.js status` 看 `pending.key`，把子 Agent 输出 `submit --file` 后再重跑 |
| 回写后仍重复出单 | `promptHash` 不一致（任务正文变了）。旧工单会被标 `superseded` 归档，按最新工单执行即可 |
| `工单文件缺失` / `ENOENT handoff/...` | `--work-dir` 变了导致工单目录不一致。同一轮推进请固定同一个 `--work-dir` |
| 结果串了别的阶段 | 检查 `handoff/queue.json` 的 `stageId`，`cancel` 作废当前待办后重跑出单 |
| 模型报 400 / 限额 | `config/agents.json` 的 `model` 只是工单里的声明，宿主模式不做换号；改回 `auto` 或交给宿主选择 |
| 阶段产物为空或只有 `(空输出)` | 子 Agent 把文档写进了文件而非 stdout。检查自定义提示词是否保留「输出方式（强约束）」段落 |
| 阶段失败 `exit 2` | 用 `--from <失败阶段>` 续跑；日志见 `logs/pipeline.log`，前序产物不会重算 |
| 安装时提示「目标目录位于 skill 源码目录内」 | `--project-root` 指向了 skill 源码目录，换一个真实项目根目录 |
| Skill 没被自动触发 | 重启宿主或执行 `/skills reload`；确认安装目录名与 `name` 一致；检查 `SKILL.md` 的 `description` 是否被宿主读取 |
| 项目级与用户级 skill 冲突 | 项目级通常优先（zCode 的 `.zcode/skills` 还优先于 `.agents/skills`），用 `--uninstall` 清理多余那份 |
| `version check` 报版本不一致 | 运行 `node scripts/version.js sync`；若刚改过代码，确认是否漏跑 `bump` |
| 宿主里仍是旧版功能 | `node scripts/version.js installed` 找出过期副本，用 `install.js --force` 升级后重启宿主 / `/skills reload` |

---

## 8. 运行时约定与退出码

- 产物 `artifacts/`、日志 `logs/`、状态文件 `data/`、`.confirm-state.json` / `.req-state.json` 与项目经理状态/升级包一律写 `--work-dir`（默认当前目录），安装目录可保持只读，且这些路径已被 `.gitignore` 忽略。
- 执行宿主由宿主侧决定：编排器只出工单，同一轮推进请固定 `--work-dir`；`model` / `fallbackModels` 仅作工单声明传递给宿主。
- 阶段失败时 `exit 2`，前序产物保留；人工升级或远程确认挂起时 `exit 42`。

| 退出码 | 含义 |
|--------|------|
| `0` | 成功 |
| `1` | 配置错误 |
| `2` | 阶段执行失败 |
| `42` | 等待人工决策（`HUMAN_DECISION_NEEDED`）或旧配置远程确认（`REMOTE_CONFIRM_NEEDED`） |

---

## 9. 目录结构

```text
agent-pipeline/
├── SKILL.md                     给宿主 Agent 的指令（触发条件与执行流程）
├── README.md                    本文档：面向人的安装、配置与排障
├── CHANGELOG.md                 版本历史、待办问题与迭代闭环
├── meta.json                    Marvis / WorkBuddy 展示元数据（版本号唯一权威来源）
├── .github/
│   └── workflows/
│       └── release.yml          GitHub Actions：打 tag 时自动打包 zip 并上传到 Release
├── config/
│   ├── host.json                宿主派发目录、队列与超时
│   ├── agents.json              8 个角色（项目经理 + 7 个专业角色）与模型
│   ├── pipeline.json            开发流 7 阶段 + 项目经理配置
│   ├── issue-pipeline.json     修复流 5 阶段 + 项目经理/旧回炉配置
│   └── github.json              Issue 监听配置模板
├── prompts/                     14 个提示词模板（项目经理 + 12 个专业阶段）
├── references/
│   ├── platform-compat.md       五平台路径、元数据、安装差异与验收清单
│   └── remote-confirm.md        远程人工决策/旧版确认协议（exit 42 状态文件 schema）
└── scripts/
    ├── install.js               一键安装 / 卸载到五个宿主，支持 --from-github 远程安装
    ├── version.js               版本号管理脚本（记录问题 / 发版 / 校验 / 盘点）
    ├── run-pipeline.js          主编排器
    ├── req-builder.js           需求构建器
    ├── init-project.js          git 拉取项目
    ├── watch-issues.js          GitHub Issue 监听
    ├── host-queue.js            宿主侧工单队列（status/list/submit/cancel）
    └── lib/
        ├── host-adapter.js      宿主派发层（出单/回写/消费/复用，不启动进程）
        ├── manager-protocol.js  REPORT/DECISION 协议解析与校验
        ├── manager-router.js    状态、返工预算与产物失效
        ├── platforms.js         五宿主安装位置共享定义
        └── version.js           版本权威读取、同步、发版与盘点
```

---

## 10. 版本管理与迭代

**版本号唯一权威来源是 `meta.json` 的 `version`。** `SKILL.md`、`README.md` 和安装时生成的 `_skillhub_meta.json` / `metadata.json` 都是派生位置，由 `scripts/version.js` 自动同步，不要手工修改。

### 语义化版本规则

| 级别 | 适用变更 | 例子 |
|------|----------|------|
| `patch` | 向后兼容的问题修复，不改变用法 | 使用中发现的 bug、提示词措辞、文档错字 |
| `minor` | 向后兼容的新能力 | 新脚本、新阶段、新宿主支持、新配置项 |
| `major` | 破坏性变更，使用者需调整 | 参数 / 目录 / 产物路径重命名、执行层变更、阶段 id 变更 |

### 迭代闭环

使用中发现问题时按固定流程逐步修复升级，避免「改了代码但版本号没动、各宿主副本版本不一致」：

```bash
# 1) 记录问题（写入 CHANGELOG.md 的 Unreleased 待办区，不改版本号）
node scripts/version.js note "在 Qoder 上 --remote 确认后状态文件路径不对"

# 2) 修复代码 / 提示词 / 配置 / 文档

# 3) 发版：递增版本 → 同步派生位置 → 把待办问题归档进新版本段落
node scripts/version.js bump patch --reason "修复 Qoder 远程确认路径" \
  --fixed "状态文件统一写 --work-dir"

# 4) 校验一致性、找出仍是旧版的宿主副本
node scripts/version.js check && node scripts/version.js installed

# 5) 升级安装（部分宿主需重启或执行 /skills reload）
node scripts/install.js --platform auto --scope user --force
```

### 命令速查

| 命令 | 作用 |
|------|------|
| `node scripts/version.js` | 版本总览：当前版本、一致性、待办问题、副本概览 |
| `node scripts/version.js check` | 校验所有位置一致；不一致 `exit 1`（适合提交前 / CI） |
| `node scripts/version.js sync` | 把派生位置同步到权威版本 |
| `node scripts/version.js note "<问题>"` | 记录使用中发现的问题 |
| `node scripts/version.js bump <level> --reason "<摘要>"` | 发版，支持 `--added` / `--changed` / `--fixed` / `--dry-run` |
| `node scripts/version.js reset <x.y.z> --reason "<原因>"` | 重置版本线：允许降级，旧版本段落归档到 CHANGELOG 文末 |
| `node scripts/version.js installed` | 盘点五宿主副本版本；发现过期副本 `exit 2` |
| `node scripts/version.js log` | 查看完整版本历史 |

**版本线重置**：`bump` 只允许递增。需要回到某个低版本重新迭代时用 `reset`，例如 `node scripts/version.js reset 1.0.0 --reason "重置版本线，从 1.0.0 重新迭代"`。它会同步所有派生位置，并把旧版本段落降级收进 `CHANGELOG.md` 的「历史归档（重置前）」区，**不丢弃历史**。重置后 `installed` 可能把仍装着旧版本号的宿主副本显示为「更新」，用 `install.js --force` 覆盖即可。

`--link` 软链安装会自动跟随源码版本，无需重复升级。完整历史与规则见 [`CHANGELOG.md`](CHANGELOG.md)。

---

## 11. 文档索引

| 文档 | 读者 | 内容 |
|------|------|------|
| [`SKILL.md`](SKILL.md) | 宿主 Agent | 触发条件、在宿主中的执行步骤、参数速查、平台兼容摘要 |
| `README.md` | 使用者 | 安装、宿主派发、完整命令、产物链、故障排查、版本管理 |
| [`CHANGELOG.md`](CHANGELOG.md) | 维护者 | 版本历史、待办问题区、SemVer 规则与迭代闭环 |
| [`references/platform-compat.md`](references/platform-compat.md) | 维护者 | 五平台发现路径、frontmatter 差异、安装验收清单 |
| [`references/remote-confirm.md`](references/remote-confirm.md) | 集成方 | 项目经理人工升级包、`--resume-human` 恢复与旧版确认状态文件 schema |

作者：trexwb · 源码：<https://github.com/trexwb/workflows>
