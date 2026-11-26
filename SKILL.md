---
name: agent-pipeline
version: 2.0.0
display_name: 多 Agent 开发流水线
description: 多 Agent 软件开发流水线编排器，由独立项目经理负责启动派活、任务书、逐阶段验收、返工/退回上游、最终验收与人工升级，专业角色仍按固定阶段交付。开发流水线含产品规划、需求拆解、架构设计、开发编码、代码审查、测试、部署 7 个专业阶段；修复流水线含分析、方案、修复、验证、PR 描述 5 个专业阶段，支持手动需求与 GitHub Issue。专业角色通过 REPORT 反馈证据，项目经理通过 DECISION 路由；只有业务范围、生产发布、不可逆操作、授权或证据冲突等无权决策事项才升级人工。阶段间用 artifacts 传递产物，支持远程人工恢复、断点续跑、宿主派发执行、角色知识库、过程记忆与动态委托；旧配置自动回退原人工确认/回炉逻辑。This skill should be used when 用户想从一个想法自动走到可交付代码、要求项目经理编排与验收多 Agent 协作、想让不同阶段使用不同角色或模型、要积累复用经验或任务记忆、要生成 A/B 双版本需求、要修复现有功能或运行 GitHub Issue 自动修复循环。触发词包括 项目经理、自动编排、流水线、pipeline、从需求到开发完成、多 Agent 协作、阶段验收、功能修复、角色知识库、角色记忆、动态委托、issue 自动修复。不调用任何 agent CLI：编排器出工单，由宿主派发子 Agent 执行后回写，适用于具备派发能力或可回写结果的任意 Agent Skills 宿主。不用于单文件小改动、简单问答或直接的代码片段生成。
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
---

# 多 Agent 开发流水线（agent-pipeline）

把软件开发拆成固定专业阶段，由独立子 Agent（角色 + 系统提示词 + 模型 + 工具白名单）执行；项目经理在阶段之间派活与验收，编排器负责组装 prompt → 落成阶段工单交给宿主派发执行 → 落盘产物 → 执行结构化路由 / 人工升级 / 断点续跑 / 限额自动切换模型。默认启用项目经理，旧配置可回退原人工确认模式。

本 skill 是**纯 Node.js 编排壳**（Node >= 18，零 npm 依赖），自身不实现 AI 能力、也**不调用任何 CLI**；AI 能力来自宿主自己的派发能力（如 Marvis 的 `dispatch_task`）。

## 技能契约

> 本节定义技能的行为规范。宿主 Agent 加载本 skill 后**必须**遵守；`scripts/` 是实现层，不改变契约。

### 目标

帮助用户「从一个想法自动推进到可交付代码」或「一条修复需求自动推进到可发布修复」：专业角色按固定阶段交付，项目经理逐阶段验收并决定继续、返工、退回上游、完成或升级人工。部署阶段只产出部署方案，最终完成表示可交付/待部署，不表示已上线。

### 输入

- 用户在宿主对话中提出的需求描述。
- 未提供需求描述时不得启动流水线：列出缺失项并请用户补充。

### 需求路由（先判定，再启动）

按需求性质二选一，两条流水线不得混用：

- **开发流水线**：从零构建新功能 / 新产品，或对现有系统做增量演进 → 7 阶段（下表一）。
- **修复流水线**：现有功能出现故障、报错、行为与预期不符、需要回退或修补 → 5 阶段（下表二）。修复需求可由用户直接描述（`--pipeline fix --requirement "<描述>"`），也可由 GitHub Issue 自动触发。

### 工作流与角色

专业阶段不得跳过：正常推进严格按表中顺序，前一阶段经项目经理验收后才能进入下一阶段；验收不通过只能由项目经理决策 `REWORK` 重跑当前阶段，或 `RETURN_UPSTREAM` 退回更早阶段。项目经理不是专业阶段，不占用表中的阶段序号，也不代替专业角色写代码、做测试或提供审查证据。

**表一：开发流水线（7 阶段，默认）**

| 序号 | 阶段 | 当前执行角色 | agent id | 阶段产出 |
|------|------|--------------|----------|----------|
| 1 | 产品规划 | 产品规划引导师 | `product-manager` | `artifacts/01-prd.md` |
| 2 | 需求拆解 | 需求拆解与功能点呈现专员 | `requirement-analyst` | `artifacts/02-tasks.md` |
| 3 | 架构设计 | 架构师 | `architect` | `artifacts/03-architecture.md` |
| 4 | 开发编码 | 全栈开发工程师 | `developer` | `artifacts/04-implementation.md` + 代码写入项目目录 |
| 5 | 代码审查 | 代码审查工程师 | `code-reviewer` | `artifacts/05-review.md` |
| 6 | 测试 | 测试工程师 | `tester` | `artifacts/06-test-report.md` |
| 7 | 部署 | 运维工程师 | `devops` | `artifacts/07-deploy.md` |

**表二：修复流水线（5 阶段，`--pipeline fix`）**

| 序号 | 阶段 | 当前执行角色 | agent id | 阶段产出 |
|------|------|--------------|----------|----------|
| 1 | 修复需求分析 | 代码审查工程师 | `code-reviewer` | `artifacts/issue-analysis.md` |
| 2 | 修复方案设计 | 架构师 | `architect` | `artifacts/issue-fix-plan.md` |
| 3 | 开发修复 | 全栈开发工程师 | `developer` | `artifacts/issue-fix-done.md` + 代码写入项目目录 |
| 4 | 修复验证 | 测试工程师 | `tester` | `artifacts/issue-test-report.md`（末行 `VERDICT: PASS|FAIL`） |
| 5 | PR 描述 | 运维工程师 | `devops` | `artifacts/issue-pr.md` |

项目经理模式下，修复验证必须保留末行 `VERDICT: PASS|FAIL`，并由项目经理结合 REPORT 与验证证据决定放行或返工；`VERDICT: FAIL`、报告缺失或证据不足均不得直接完成。默认单阶段最多返工 2 次、总返工 6 次，预算耗尽升级人工。旧配置（`projectManager` 缺失或 `enabled: false`）保留原自动回炉：命中 `VERDICT: FAIL` 且轮数未用尽时回到开发修复，默认最多 2 轮，`--fix-rounds` 可调，`0` 关闭；报告缺少 VERDICT 或轮数用尽时失败退出，不再默认放行。

### 项目经理控制层（默认启用）

| 控制角色 | agent id | 职责 | 产出 |
|---------|----------|------|------|
| 项目经理 | `project-manager` | 启动派活、生成任务书、验收 REPORT 与产物、返工/退回上游、最终验收、人工升级 | `pm-handoff.md`、`pm-decisions.md`、`pm-project-state.json`、`pm-escalation.json`、`99-acceptance.md` |

**协作协议**

1. 首次执行由项目经理生成首阶段 `workOrder`：目标、必须完成、验收检查、约束、明确不做。
2. 每个专业阶段输出正文 + 一个 `REPORT` JSON 块，字段包括 `status`、`summary`、`completedTasks`、`evidence`、`issues`、`unverified`、`decisionsNeeded`、`recommendedNextRole`。REPORT 由编排器剥离，不污染正式产物。
3. 项目经理读取任务书、上游输入、当前产物与 REPORT，输出正文 + 一个 `DECISION` JSON 块：
   - `PROCEED`：当前阶段通过，只为紧邻下一阶段派活；
   - `REWORK`：重跑当前阶段；
   - `RETURN_UPSTREAM`：退回更早阶段，目标及下游旧产物、验收结论全部失效；
   - `ESCALATE`：提交完整人工决策包；
   - `COMPLETE`：仅完整流水线最后阶段使用，生成最终验收单。
4. 缺少有效 REPORT 时不得 `PROCEED` / `COMPLETE`；不得跳阶段，也不得在最后阶段用 `PROCEED` 冒充完成。
5. 只有业务范围变化、生产发布、不可逆操作、新增授权、预算/工期重大取舍、阻塞问题豁免或证据冲突才升级人工。普通技术返工不得上交用户。
6. 人工升级写 `pm-escalation.json`、打印 `HUMAN_DECISION_NEEDED` 并退出 42；用 `--resume-human <decisionId> --amend "<人工决策原文>"` 恢复，保留状态、历史和已花返工预算。重复传 `--requirement` 或显式 `--from` 会开启新的管理运行，不能用于恢复人工升级。

两条内置流水线成功路径约需 15 轮（开发）与 11 轮（修复）宿主派发，含项目经理派活/验收；返工或人工升级会增加轮次。

> 提示词模板中「·架构方案推荐师」等后缀是对该角色能力的补充说明，不构成额外角色。

### 角色记忆与协作（知识库 · 记忆 · 动态委托）

每个专业角色默认同时具备三种能力，项目经理也可使用知识库与记忆，但项目经理门禁禁止动态委托；同一工作目录下的重复运行持续积累：

**1. 知识库（跨任务的可复用事实经验）**

- 注入：该角色 `knowledge/<agent-id>.md` 末尾最近 4000 字符拼进 prompt；沉淀：`KNOWLEDGE APPEND` 标记段抽取入库，产物自动剥离。
- 位置默认 `<work-dir>/knowledge/`；`--knowledge-dir` 指向固定目录可跨项目共享；`--no-knowledge` 全局关闭，角色 `knowledge: false` 按角色关闭。

**2. 记忆（任务过程上下文，与知识库互补）**

- 注入：执行阶段时自动带出 `[工作记忆·本阶段]`（该角色上次执行本阶段的摘要、用户曾给的修订意见）与 `[工作记忆·前序阶段交接]`（其他角色写给后续阶段的便签）——断点续跑、`--from` 重跑、修订后重跑不再失忆。
- 沉淀：角色输出 `MEMORY APPEND` 标记段（`summary:` 本次执行摘要 + `handoff:` 给后续阶段的交接提示），分别写入 `memory/<agent-id>.md` 与 `memory/handoffs.md`；**用户修订意见（交互 amend / `--amend` / 回炉报告）由编排器自动记入记忆**，重跑同阶段时自动提醒「用户曾要求…」。
- `--no-memory` 全局关闭；角色 `memory: false` 按角色关闭；目录固定 `<work-dir>/memory/`。

**3. 动态委托（角色可插手其他角色的工作）**

- 角色执行中发现本阶段更适合其他角色时，输出 `DELEGATE` 标记段（`target:`/`reason:`/`handoff:`）；编排器自动**换目标角色重跑本阶段**，原角色的初步产出与交接说明作为上下文带入，知识/记忆沉淀归属最终执行者。
- 边界：专业角色只能委托给 `agents.json` 内的角色；每阶段最多换一次执行角色（防循环）；**只换执行者，不改变阶段顺序、产物路径与验收要求**；确认责任仍在原阶段。项目经理派活/验收门禁不参与委托，避免验收者转交责任。
- `--no-delegate` 全局关闭。

三种能力的标记段均附在回复正文之后、不计入产物文档；知识/记忆文件均为追加式 Markdown，可人工编辑修剪。

### 执行步骤

1. 接收用户输入的需求。
2. 按「需求路由」判定流水线类型（开发 / 修复），并向用户说明判定结果。
3. 由项目经理生成首阶段任务书，调用专业角色执行，再读取 REPORT 与产物进行验收。
4. 按 DECISION 继续、返工、退回上游或升级人工；只有专业阶段全部通过后，由最后阶段生成最终验收单。
5. 汇总实际执行结果、返工次数、未验证项、剩余风险和未执行的部署动作。

实现层映射：每个专业阶段与每次项目经理派活/验收对应一份工单与一次宿主派发，产物由编排器从回写结果落盘。项目经理模式不使用旧 `confirm` 人工确认点，而由结构化门禁控制；`--interactive` 仅用于人工升级时终端应答。`--from` / `--to` 用于失败续跑或用户明确指定的阶段范围；`--from` 会标记本次范围及下游产物失效，不得用来默认跳过验收。恢复人工升级必须用 `--resume-human`。旧配置才使用原 `--interactive` / `--remote` 阶段确认与修复自动回炉。

### 输出格式

按阶段分条输出，每条包含**阶段序号与名称、当前执行角色、该阶段产出**；最终输出**一条全流程汇总**，按实际执行的流水线覆盖全部阶段：

```text
【阶段 1｜产品规划】
执行角色：产品规划引导师
阶段产出：<产物摘要 + artifacts/01-prd.md 路径>

（后续阶段同格式）

【全流程汇总｜开发流水线】
1 产品规划 ✓ / 2 需求拆解 ✓ / 3 架构设计 ✓ / 4 开发编码 ✓ / 5 代码审查 ✓ / 6 测试 ✓ / 7 部署 ✓
代码目录：<projectDir>；日志：logs/pipeline.log；未实际执行的部署动作说明
```

项目经理模式还须汇报：最终验收单 `artifacts/99-acceptance.md`、决策日志 `artifacts/pm-decisions.md`、返工/退回上游次数、人工升级与恢复结果。若退出 42，先汇报 `pm-escalation.json` 中的问题、选项、推荐、影响与证据，不得把等待人工说成阶段失败或已完成。

修复流水线同格式，汇总行为：

```text
【全流程汇总｜修复流水线】
1 修复需求分析 ✓ / 2 修复方案设计 ✓ / 3 开发修复 ✓（项目经理返工 N 轮）/ 4 修复验证 ✓（VERDICT: PASS）/ 5 PR 描述 ✓
代码目录：<projectDir>；验收单：artifacts/99-acceptance.md；日志：logs/pipeline.log；未通过时注明失败明细与剩余风险
```

### 约束

- **输出语言**：简体中文；英文术语、代码、命令与专名保持原样。
- **阶段与角色**：专业阶段不得跳过或合并；正常推进按固定顺序，验收不通过由项目经理选择当前阶段返工或更早阶段重修。项目经理不代替专业角色交付。
- **流水线路由**：修复类需求（现有功能故障/报错/行为不符）必须走修复流水线，不得用 7 阶段开发流硬套；从零构建必须走开发流水线。路由不确定时向用户确认。
- **信息缺失**：列出缺失项并请用户补充后再继续，不得自行编造业务规则、数据或结论。
- **超出范围**：说明超出范围的原因，返回可用的阶段与角色清单供用户选择，不启动流水线。
- **歧义与不确定**：标注假设点并请求用户确认后再执行对应阶段。
- **知识库与记忆安全**：知识库只沉淀可复用的事实性经验，记忆只记录任务过程上下文；两者均严禁记录密钥、token、凭据与敏感路径。
- **委托边界**：动态委托只换本阶段执行者，不得用于跳过阶段、合并阶段或转交人工确认责任；产物验收标准不因委托放松。

## 何时使用

| 场景 | 入口 |
|------|------|
| 新功能需求已明确，想一次跑完规划到部署 | `scripts/run-pipeline.js`（默认开发流水线） |
| 现有功能出了故障/报错/行为不符，想直接描述问题走「分析→方案→修复→验证→PR 描述」 | `scripts/run-pipeline.js --pipeline fix --requirement "<问题描述>"` |
| 需求还没想清楚，需要先澄清并生成双版本需求 | `scripts/req-builder.js` |
| 已有仓库，希望新 Issue 自动分析、修复、验证、出 PR 描述 | `scripts/watch-issues.js`（内部走 `--pipeline fix`） |
| 想先把远端项目拉到开发分支再跑流水线 | `scripts/init-project.js` |

不要在只需要改一个函数、回答一个问题时启动流水线；全流程会有多轮宿主派发，成本与时间较高。请求超出编排范围时，按「约束」说明原因并返回上面两条流水线的阶段清单供用户选择，不要启动流水线。

## 在宿主中如何执行

本节是给加载了本 skill 的宿主 Agent 的操作指令。所有路径以 **skill 根目录**（`SKILL.md` 所在目录，下称 `<SKILL_DIR>`）为基准；安装后的目录可能只读，**所有运行时产物必须写在工作目录而非 `<SKILL_DIR>`**。

1. **定位**。确定 `<SKILL_DIR>` 绝对路径，并确定工作目录 `<WORK_DIR>`：优先使用用户指定的目录，否则用当前项目根目录。执行 `node --version` 确认 Node >= 18。
2. **确认执行方式**。本 skill 不调用任何 CLI：运行 `node <SKILL_DIR>/scripts/run-pipeline.js --dry-run --project-name <项目名>` 只会打印阶段链与提示词配置。正式运行时，编排器把阶段任务正文落成**工单**（`<WORK_DIR>/handoff/orders/<key>.order.md`）并以**退出码 3** 交还执行权；宿主（如 Marvis）用自身派发能力（`dispatch_task` 派子 Agent）执行工单，再用 `node <SKILL_DIR>/scripts/host-queue.js --work-dir <WORK_DIR> submit --file <输出文件>` 回写结果，然后**重跑原命令**继续。全过程零外部进程、零 CLI 依赖。
3. **选择入口**。
   - 需求模糊：先 `node <SKILL_DIR>/scripts/req-builder.js --guide` 取得 7 维度引导，收集用户回答后 `--build "<需求文本>"` 生成 A/B 双版本，把两个版本呈现给用户选择，再用 `--select A|B` 写入 `artifacts/00-requirement.md`。可加 `--auto-run --project-name <项目名>` 自动续跑。
   - 新功能需求明确：直接 `node <SKILL_DIR>/scripts/run-pipeline.js --project-name <项目名>`；项目经理会派活并逐阶段验收。
   - 修复需求（现有功能故障/报错/行为不符）：`node <SKILL_DIR>/scripts/run-pipeline.js --project-name <项目名> --project-dir <代码目录> --pipeline fix --requirement "<问题描述>"`。验证失败由项目经理决定返工或升级，不自动跳过验证。
4. **处理人工升级**。项目经理模式退出 42 时读取 `<WORK_DIR>/artifacts/pm-escalation.json`，向用户转述完整决策包；收集决定后以 `--resume-human <pending.decisionId> --amend "<人工决策原文>"` 续跑，不要重复传 `--requirement` 或 `--from`。`--interactive` 可在终端直接应答。旧配置的 `--remote` 才使用 `artifacts/.confirm-state.json` 与 `REMOTE_CONFIRM_NEEDED`，按旧协议「确认 → `--from <nextStageId>`；修改 → `--from <stageId> --amend`」恢复。
5. **失败与续跑**：阶段失败 exit 2，用 `--from <失败阶段>` 续跑，前序产物保留不浪费；退出码 0 成功、1 配置错误、3 工单待宿主执行、42 等待人工决策/远程确认。
6. **交付汇报**：严格按「输出格式」章节输出：逐阶段分条列出阶段序号与名称、当前执行角色、该阶段产出（含产物路径），最后给出覆盖全部专业阶段的汇总，并注明项目经理验收单、代码目录 `<projectDir>`、日志 `logs/pipeline.log` 与编排器未实际执行的部署动作。

## 快速开始

前置：Node.js >= 18；无需安装或登录任何 agent CLI。以下命令中 `node scripts/...` 均相对于 `<SKILL_DIR>`；在 skill 目录外执行时换成绝对路径，并用 `--work-dir <WORK_DIR>` 指定产物位置。每条命令只推进一个工单：看到退出码 3 就派子 Agent 执行工单、回写结果、再重跑。

```bash
# 0. 演练：只打印阶段链与提示词配置，不派发、不落工单
node scripts/run-pipeline.js --project-name demo-app --dry-run

# 1. 默认项目经理模式：自动派活、逐阶段验收；只有无权决策时暂停
node scripts/run-pipeline.js --project-name demo-app

# 2. 终端交互仅用于项目经理升级人工时直接应答
node scripts/run-pipeline.js --project-name demo-app --interactive

# 3. 只跑指定范围；恢复时从状态记录的下一阶段继续
node scripts/run-pipeline.js --project-name demo-app --to 02-requirements
node scripts/run-pipeline.js --project-name demo-app

# 4. 失败续跑或用户明确要求重做某阶段（会使该阶段及下游产物失效）
node scripts/run-pipeline.js --project-name demo-app --from 04-develop --amend "修订意见"

# 5. 项目经理退出 42 后，按决策包恢复
node scripts/run-pipeline.js --project-name demo-app \
  --resume-human human-123 --amend "人工决定原文"
```

需求构建器与功能修复：

```bash
node scripts/req-builder.js --guide
node scripts/req-builder.js --build "<你的需求文本>"
node scripts/req-builder.js --select A
node scripts/req-builder.js --select A --auto-run --project-name demo-app

# 手动修复需求：直接描述故障，走「分析→方案→修复→验证→PR 描述」5 阶段
node scripts/run-pipeline.js --project-name demo-app --project-dir ./demo-app \
  --pipeline fix --requirement "登录页在 Safari 下提交报错 XXX"
# 项目经理根据 VERDICT 与 REPORT 决定返工/退回上游；单阶段≤2、总计≤6，超出升级人工

# 编辑 config/github.json（owner/repo/localProjectDir，token 走 GITHUB_TOKEN 环境变量）
node scripts/watch-issues.js --once        # 单轮，配 cron / 计划任务
node scripts/watch-issues.js               # 默认常驻轮询（不带 --once 即常驻）
```

## 参数速查（run-pipeline.js）

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--project-name` | 项目名，注入 prompt 的 `{projectName}` | 必填 |
| `--project-dir` | 项目代码目录（开发/测试/部署的工作目录） | `<project-root>/<project-name>` |
| `--project-root` | 项目根目录 | 当前目录 |
| `--work-dir` | 工作目录：artifacts/、logs/、状态文件与自定义模板的根 | 当前目录 |
| `--pipeline feature\|fix` | 流水线预设：开发 7 阶段 / 修复 5 阶段，与 `--pipeline-config` 互斥 | `feature` |
| `--requirement "<文本>"` | 需求原文，写入 `artifacts/00-requirement.md` 作首阶段输入 | 无 |
| `--from` / `--to` | 起止阶段 id | 首/末阶段 |
| `--interactive` | 项目经理升级人工时在终端应答；旧配置用于 confirm 阶段审阅 | false |
| `--remote` | 旧配置 confirm 阶段写状态文件并 exit 42；项目经理人工升级本身始终支持非交互退出 | false |
| `--init-only` | 旧配置跑到最后一个 confirm 阶段；项目经理模式跑到本次范围内最后一个 confirm 阶段 | false |
| `--amend "<意见>"` | 修订意见追加进 `--from` 阶段；与 `--resume-human` 配合注入人工决策 | 无 |
| `--resume-human <id>` | 按 `pm-escalation.json` 的 decisionId 恢复人工升级，必须同时提供 `--amend` | 无 |
| `--fix-rounds <n>` | 仅旧配置修复回炉轮数，`0`=关闭；项目经理模式由返工预算控制 | 流水线配置 `retry.maxRounds`（默认 2） |
| `--knowledge-dir <dir>` | 角色知识库目录（注入历史经验 + 沉淀新知识） | `<work-dir>/knowledge` |
| `--no-knowledge` | 关闭角色知识库（不注入、不沉淀） | false |
| `--no-memory` | 关闭角色记忆（执行摘要/交接便签/用户修订入记忆） | false |
| `--no-delegate` | 关闭动态委托（角色声明换更合适角色执行本阶段） | false |
| `--dry-run` | 只打印命令不执行 | false |
| `--pipeline-config` / `--agents-config` / `--host-config` | 配置路径覆盖 | `config/` 下默认值 |
| `--host-script <js>` | 用本地 JS 替代宿主派发（进程内 `respond(prompt)` 返回正文），供离线自测 | 无 |
| `--timeout-ms` | 单阶段执行超时 | `config/host.json` 的 `timeoutMs` |

## 多平台兼容与安装

本 skill 遵循 **Agent Skills 开放标准**：目录内 `SKILL.md` 的 `name` + `description` 是五个宿主的唯一必需字段；其余 frontmatter 字段与元数据文件按宿主能力可选，未知字段会被忽略。安装目录名必须与 `name` 一致，即 `agent-pipeline`（小写 kebab-case，zCode 强制要求）。

| 宿主 | 用户级目录 | 项目级目录 | 附加元数据 |
|------|-----------|-----------|-----------|
| WorkBuddy | `~/.workbuddy/skills/agent-pipeline/` | `.workbuddy/skills/agent-pipeline/` | `_skillhub_meta.json` |
| CodeBuddy | `~/.codebuddy/skills/agent-pipeline/` | `.codebuddy/skills/agent-pipeline/` | `_skillhub_meta.json` |
| zCode | `~/.zcode/skills/agent-pipeline/` 或 `~/.agents/skills/agent-pipeline/` | `.zcode/skills/agent-pipeline/` 或 `.agents/skills/agent-pipeline/` | 无 |
| Marvis | `~/.marvis/skills/custom/agent-pipeline/` | 不支持项目级 | `meta.json`（必需） |
| Qoder | `~/.qoder/skills/agent-pipeline/`（国内版 `~/.qoder-cn/skills/agent-pipeline/`） | `.qoder/skills/agent-pipeline/` | `metadata.json`（可选） |

一键安装（在 skill 源码目录执行）：

```bash
# 查看将要安装到哪些位置，不写任何文件
node scripts/install.js --dry-run

# 只给本机已检测到的宿主做用户级安装
node scripts/install.js --platform auto --scope user

# 指定宿主、项目级安装（复制而非软链）
node scripts/install.js --platform codebuddy,workbuddy,qoder,zcode,marvis --scope project --project-root /path/to/repo

# 开发模式：建立软链，改源码即时生效
node scripts/install.js --platform auto --scope user --link

# 卸载
node scripts/install.js --platform auto --scope user --uninstall
```

各宿主的发现优先级、frontmatter 差异与已知限制见 `references/platform-compat.md`（执行链路与宿主无关，本 skill 不调用任何 CLI）。

## 宿主派发层

`scripts/lib/host-adapter.js` 是唯一的执行层：它**不启动任何进程**，只负责「工单落盘 → 交还执行权 → 接收回写 → 复用结果」。角色、提示词、上下文全部拼进工单正文，由宿主侧的派发能力（如 Marvis 的 `dispatch_task`）执行。

| 环节 | 行为 |
|------|------|
| 出单 | 任务正文写入 `handoff/orders/<key>.order.md`，`handoff/queue.json` 登记 pending（含 `key`、`promptHash`、`stageId`），进程以 `3` 退出 |
| 回写 | 宿主把子 Agent 输出写到文件，用 `host-queue.js submit --file <f>` 落到 `handoff/results/<key>.result.md` |
| 消费 | 重跑时同 `key` 且 `promptHash` 一致即消费结果，并把工单/结果归档到 `handoff/done/` |
| 复用 | 阶段已验收则重放 `handoff/executions/` 缓存，不再重复派发；阶段已执行完则直接进入项目经理验收 |
| 作废 | 工单属于其它阶段，或同阶段但任务正文已变，旧工单标记 `superseded` 并归档，避免结果串用 |

目录约定（均相对 `--work-dir`）：`handoff/orders/`、`handoff/results/`、`handoff/done/`、`handoff/executions/`、`handoff/queue.json`，可用 `config/host.json` 覆盖。

宿主侧常用命令：

```bash
node scripts/host-queue.js --work-dir <WORK_DIR> status        # 看当前待办工单
node scripts/host-queue.js --work-dir <WORK_DIR> submit --file <输出文件>
node scripts/host-queue.js --work-dir <WORK_DIR> cancel        # 作废当前待办
```

## 定制与扩展

- **改阶段**：编辑 `config/pipeline.json`，增删 `stages` 项；旧配置中 `confirm: true` 标记人工确认点；`input` 指向前序产物；`output: null` 表示不落盘该阶段 stdout。项目经理模式下专业阶段仍不得跳过。
- **项目经理模式**：`projectManager.enabled=false` 回退旧人工确认/回炉逻辑；`kickoff` 控制首次派活；`maxReworkRounds` / `maxTotalReworks` 控制返工预算；状态、交接、决策日志、升级包与验收单路径均可配置。
- **改角色/模型**：编辑 `config/agents.json`；`model` / `fallbackModels` 仅在宿主侧生效（工单里保留偏好声明），宿主模式不做限额换号。
- **改提示词**：编辑 `prompts/*.md`，支持 `{projectName}` / `{projectDir}` / `{userNeed}` 占位符。把同名文件放 `--work-dir` 下可覆盖内置模板，无需改动只读的安装目录。
- **管知识库与记忆**：`knowledge/<agent-id>.md`、`memory/<agent-id>.md`、`memory/handoffs.md` 均为追加式 Markdown，可随时人工修剪过时条目；知识库跨项目共享用 `--knowledge-dir ~/.agent-pipeline/knowledge`；按角色关闭改 `agents.json` 的 `knowledge` / `memory` 字段；`--no-knowledge` / `--no-memory` / `--no-delegate` 全局关闭对应能力。
- **换执行宿主**：无需改配置——编排器只出工单，谁来执行由宿主决定；离线自测可用 `--host-script <js>` 注入进程内响应器。

## 目录

```
agent-pipeline/
├── SKILL.md                 # 本文件（给宿主 Agent 的指令）
├── meta.json                # Marvis / WorkBuddy 展示元数据（版本号唯一权威来源）
├── CHANGELOG.md             # 版本历史、待办问题与迭代闭环
├── README.md                # 仓库说明与安装入口
├── config/                  # host / agents / pipeline / issue-pipeline / github 五份配置
├── prompts/                 # 14 个提示词模板（项目经理 + 12 个专业阶段）
├── references/
│   ├── platform-compat.md   # 五平台路径、元数据、CLI 差异
│   └── remote-confirm.md    # 远程人工决策与旧版确认协议
└── scripts/
    ├── install.js           # 一键安装到五个宿主
    ├── version.js           # 版本号管理 CLI（记录问题 / 发版 / 校验 / 盘点）
    ├── run-pipeline.js      # 主编排器
    ├── req-builder.js       # 需求构建器
    ├── init-project.js      # git 拉取项目
    ├── watch-issues.js      # GitHub Issue 监听
    ├── host-queue.js        # 宿主侧工单队列操作（status/list/submit/cancel）
    └── lib/
        ├── host-adapter.js  # 宿主派发层（出单/回写/消费/复用，不启动进程）
        ├── manager-protocol.js # REPORT/DECISION 协议校验
        ├── manager-router.js   # 状态、返工预算与产物失效
        ├── platforms.js
        └── version.js       # 版本权威读取、同步、发版与盘点
```

> 运行时产物 `artifacts/`、`logs/`、`data/` 与状态文件一律写入 `--work-dir`（默认当前目录），不写入 skill 安装目录。

## 注意事项

1. **执行边界**：编排器不 spawn 任何外部命令，也就不存在 CLI 参数拼装与权限参数；阶段实际权限由宿主派发的子 Agent 决定。
2. **产物上下文**：每阶段自动把 `input` 指定的产物全文拼进 prompt；缺失仅告警不中断。提示词模板要求子 Agent 把文档正文输出到 stdout，由编排器统一落盘，严禁子 Agent 自行写产物文件。
3. **跨平台**：无 CLI 调用，macOS / Windows / Linux 行为一致，不存在 `.cmd` 包装与 shell 转义问题。
4. **只读安装目录**：市场安装的 skill 目录可能只读；配置覆盖用 `--work-dir`，不要用编辑安装目录的方式定制。
5. **退出码**：0 成功；1 配置错误；2 阶段执行失败；3 工单已就绪、等待宿主派发后回写；42 等待人工决策（`HUMAN_DECISION_NEEDED`）或旧配置远程确认（`REMOTE_CONFIRM_NEEDED`）。

## 版本

2.0.0（唯一权威来源：`meta.json` 的 `version` 字段）

维护者用 `node scripts/version.js` 记录使用中问题、发版与校验一致性；版本历史与迭代流程见 `CHANGELOG.md`。升级各宿主已安装副本用 `node scripts/install.js --force`。
