# 更新日志

本文件记录 agent-pipeline 的版本迭代。**版本号的唯一权威来源是 `meta.json` 的 `version` 字段**；`SKILL.md`、`README.md` 与安装时生成的元数据文件都是派生位置，由 `scripts/version.js` 自动同步，不要手工改。

所有版本遵循语义化版本 `主版本.次版本.修订号`（SemVer）。

## 版本号规则

| 级别 | 适用变更 | 典型场景 |
|------|----------|----------|
| `patch` | 向后兼容的问题修复，不改变用法 | 使用中发现的 bug、提示词措辞、文档错字、配置默认值修正 |
| `minor` | 向后兼容的新能力 | 新脚本、新阶段、新宿主支持、新配置项、新文档 |
| `major` | 破坏性变更，使用者需调整 | 参数或目录重命名、产物路径变化、移除适配器、frontmatter 必填字段变化、阶段 id 变更 |

一次发布只表达一个主题；若同时包含新能力和破坏性变更，按 `major` 发版。

**版本线重置**：`bump` 只允许递增。需要回到低版本重新迭代时用 `reset <x.y.z> --reason "<原因>"`（允许降级），它会同步所有派生位置，并把旧版本段落降级收进文末「历史归档（重置前）」区，不丢弃历史。当前版本线自 `1.0.0`（2026-11-05）重新开始。

## 迭代闭环

使用过程中发现问题后，按固定流程逐步修复升级，避免「改了代码但版本号没动、各平台副本版本不一致」：

```bash
# 1. 记录问题（写入下方 Unreleased 待办区，不会改变版本号）
node scripts/version.js note "在 Qoder 上 --remote 确认后状态文件路径不对"

# 2. 修复代码 / 提示词 / 配置 / 文档

# 3. 发版：递增版本号 → 同步所有派生位置 → 把待办问题归档进新版本段落
node scripts/version.js bump patch --reason "修复 Qoder 远程确认路径" --fixed "状态文件统一写 --work-dir"

# 4. 校验一致性、找出仍是旧版的宿主副本
node scripts/version.js check && node scripts/version.js installed

# 5. 升级安装（部分宿主需重启或执行 /skills reload）
node scripts/install.js --platform auto --scope user --force
```

`check` 适合放在提交前或 CI 中：版本位置不一致时以 `exit 1` 失败。`installed` 发现过期副本时以 `exit 2` 提示。软链安装（`--link`）会自动跟随源码版本，不需要重复升级。

重置版本线是独立操作，不走上面的递增流程：

```bash
node scripts/version.js reset 1.0.0 --reason "重置版本线，从 1.0.0 重新迭代"
node scripts/version.js check
node scripts/install.js --platform auto --scope user --force
```

## [Unreleased]

### Added

- 新增独立 `project-manager` 角色，负责启动派活、任务书、逐阶段验收、返工/退回上游、最终验收与人工升级；开发流与修复流默认启用。
- 新增专业 `REPORT` 与项目经理 `DECISION` 协议、持久状态机、下游产物失效、返工预算、验收单和 `--resume-human` 人工恢复。
- 新增 fake CLI 集成测试，覆盖两条流水线、返工、退回上游、人工升级/恢复、预算、部分续跑、旧配置与演练模式。

### Changed

- `config/agents.json` 增至 8 个角色；项目经理与只负责 PRD 的 `product-manager` 分离，验收门禁禁止动态委托。
- 同步技能契约、README、远程人工决策协议与展示元数据；旧配置继续使用原人工确认/回炉逻辑。

### Fixed

- 人工升级退回更早阶段时，在暂停前保存下游产物失效记录；远程恢复保留升级包任务书、状态与历史。
- 项目经理派活任务书现在连续注入下一专业阶段，并持久化到管理状态，部分执行/中断恢复后不会丢失。
- 旧修复回炉报告缺少 `VERDICT: PASS/FAIL` 时失败关闭，不再默认通过。

### Pending notes

使用中发现的问题先记在这里；修复后运行 `bump`，这些条目会自动归档到新版本的「本次归档的待办记录」。

<!-- NOTES:START -->
<!-- 用 node scripts/version.js note "问题描述" 追加 -->
<!-- NOTES:END -->

## [2.0.0] - 2026-11-26

> 执行层改为宿主派发（工单+退出码3+回写），完全移除 CLI 适配层与 config/cli.json

### Added

- 新增 `scripts/lib/host-adapter.js`：宿主派发执行层，保持与旧 `adapter.js` 同一 runner 接口（`name` / `label` / `capabilities` / `probe` / `run` / `extraModels` / `supportsFallbackFlag`），但**不 spawn 任何进程**，只负责「出工单 → 交还执行权 → 接收回写 → 复用结果」
- 新增 `scripts/host-queue.js`：宿主侧工单队列操作，`status` / `list [--json]` / `submit --file <f>` / `submit --text` / `cancel`
- 新增 `config/host.json`：声明 `orderDir` / `resultDir` / `doneDir` / `queueFile` / `keepDone`
- 新增退出码 `3`：工单已就绪、等待宿主执行并回写后重跑
- 新增 `--host-script <js>` 与 `AGENT_PIPELINE_FAKE_SCRIPT`：注入进程内响应器 `respond(prompt, ctx)`，用于离线自测
- 工单幂等：`handoff/queue.json` 的 `pending` 记录 `key`（阶段--角色）、`promptHash`、`stageId`；同键同哈希只等待不重复出单，阶段过期或正文变化则标记 `superseded` 并归档到 `handoff/done/`
- 阶段结果缓存 `handoff/executions/`：已验收阶段重跑直接重放，不再重复派发
- 项目经理派活幂等与断点续跑：决策日志与 history 去重、按状态文件自动前移起点、`kickoffDone` 标记、需求哈希复用既有状态、`manager-review` 阶段直接复用已有产物
- 新增两个端到端测试：真实工单链路（落工单 exit 3 → 回写 → 推进到 7 阶段 complete）、未回写时以 exit 3 交还执行权且同正文复用工单键

### Changed

- `scripts/run-pipeline.js`、`scripts/req-builder.js` 的 CLI 调用全部改为宿主派发；`--cli-config` / `--adapter` 参数替换为 `--host-config` / `--host-script`
- `CONFIG` 装配改走 `hostAdapter.loadConfig(workRoot, config/host.json, { fakeScript, projectName })`；模型候选链在宿主模式恒为单次执行，不再做限额换号
- `SKILL.md` / `README.md` / `references/platform-compat.md` 全面改写为宿主派发口径：删除适配器对照表、`*_CLI_CMD` 环境变量、`permissions: skip` 等 CLI 专属内容
- `config/agents.json` 注释改为「model / fallbackModels 仅作工单偏好声明」
- 全部文档（`SKILL.md` / `README.md` / `meta.json` / `references/*` / `config/host.json` / 脚本注释与运行期文案）统一为「基于宿主程序本身」口径：不再以「不调用 CLI」作为描述主线，改为正面说明阶段执行由宿主程序自身的 Agent 派发能力完成；同步更新 `tests/manager.test.js` 两处文案断言

### Removed

- 删除 `scripts/lib/adapter.js`：codebuddy / claude / codex / plain 四种方言与宿主探测逻辑全部下线
- 删除 `config/cli.json`：`hostCommands`、`permissions`、CLI 超时配置不再存在
- 移除 `AGENT_PIPELINE_HOST` / `AGENT_PIPELINE_ADAPTER` / `CODE_BUDDY_CMD` 等 CLI 探测与覆盖变量
- 移除 Windows `.cmd` 包装器规避逻辑（无外部进程后不再需要）
- **移除模型维度**：删除模型候选链、`fallbackModels`、`runner.extraModels()`、`supportsFallbackFlag`、`capabilities.model`、`isQuotaError()` 限额换号与 `--timeout-ms`；阶段执行改为严格单次派发，失败即阶段失败
- 移除 `config/agents.json` 与 `agents.demo.json` 中的 `model` / `fallbackModels` / `tools` / `effort` / `maxTurns` 字段（共 70 处），角色只剩提示词 + `knowledge` / `memory` 开关
- 移除 `host.json` 与 DEFAULT_CONFIG 中的 `timeoutMs` / `permissions` / `outputFormat`，runner 接口收敛为 `name` / `label` / `probe` / `run`

### Breaking

- 依赖 `--adapter` / `--cli-config` 的调用方式失效，改用 `--host-config`；依赖外部 CLI 自动奔跑的用法改为「跑 → exit 3 → 派发执行 → 回写 → 重跑」的宿主驱动循环

## [1.3.0] - 2026-11-13

> 新增角色过程记忆(执行摘要/交接便签/用户修订自动入记忆,重跑带出)与动态委托(DELEGATE 标记段换更合适角色重跑本阶段,每阶段最多一次)

### Added
- 角色过程记忆（与知识库互补，`--no-memory` 关闭，目录 `<work-dir>/memory/`）：执行阶段时自动注入 `[工作记忆·本阶段]`（该角色上次执行本阶段的摘要与用户曾给的修订意见）与 `[工作记忆·前序阶段交接]`（其他角色写给后续阶段的便签）——断点续跑、`--from` 重跑、修订后重跑不再失忆；角色输出 `MEMORY APPEND` 段沉淀 `summary:`（执行摘要 → `memory/<agent-id>.md`）与 `handoff:`（交接提示 → `memory/handoffs.md`）；用户修订意见（交互 amend / `--amend` / 回炉报告）由编排器自动记入记忆
- 动态委托（`--no-delegate` 关闭）：角色执行中发现本阶段更适合其他角色时输出 `DELEGATE` 标记段（target/reason/handoff），编排器自动换目标角色重跑本阶段，原角色初步产出与交接说明作为上下文带入，知识/记忆沉淀与产物归属最终执行者；每阶段最多换一次执行角色（防 A→B→A 循环），只换执行者、不改变阶段顺序/产物路径/验收要求
- `config/agents.json` 每个角色新增 `memory` 开关（默认 `true`，`false` 按角色关闭）；注入块统一为「角色协作上下文」（记忆 + 知识库 + 标记段协议一次注入）

### Fixed
- 修复 SKILL.md 中 `### 执行步骤` 标题重复出现的问题（1.2.0 编辑遗留）

## [1.2.0] - 2026-11-13

> 新增角色知识库：执行时注入历史经验、完成后自动沉淀可复用知识（KNOWLEDGE 标记段抽取），项目级默认目录，--knowledge-dir/--no-knowledge 控制

### Added
- `run-pipeline.js` 新增角色知识库（默认开启）：每阶段执行时把该角色 `knowledge/<agent-id>.md` 末尾最近 4000 字符历史经验注入 prompt；角色在回复末尾以 `KNOWLEDGE APPEND` 标记段输出新学条目，编排器抽取后带「时间｜项目｜阶段」元数据头追加进知识库，产物文档自动剥离该段——零额外 CLI 调用，开发/修复两条流水线与 watch-issues 自动继承
- `run-pipeline.js` 新增 `--knowledge-dir <dir>`（默认 `<work-dir>/knowledge`，指向固定目录可跨项目共享角色能力）与 `--no-knowledge`（全局关闭）
- `config/agents.json` 每个角色新增 `knowledge` 开关（默认 `true`，`false` 按角色关闭注入与沉淀）
- SKILL.md 技能契约新增「角色知识库」小节与「知识库安全」约束（只沉淀可复用事实经验，严禁密钥/token/敏感路径）；README 新增「角色知识库」章节与目录说明

## [1.1.0] - 2026-11-13

> 新增功能修复需求编排：--pipeline fix 快捷入口、--requirement 需求注入、验证未通过自动回炉重修（--fix-rounds）、watch-issues 按 issue 隔离产物并改用正式参数传递

### Added
- `run-pipeline.js` 新增 `--pipeline feature|fix` 流水线预设（与 `--pipeline-config` 互斥），修复需求不再依赖 GitHub Issue 监听即可编排
- `run-pipeline.js` 新增 `--requirement "<文本>"`：需求原文写入 `artifacts/00-requirement.md` 作首阶段输入，开发/修复两条流水线通用
- 修复流水线自动回炉：`config/issue-pipeline.json` 新增顶层 `retry` 块（checkStage/failPattern/resumeStage/maxRounds），验证产物末行 `VERDICT: FAIL` 且轮数未用尽时自动携带验证报告回「开发修复」重修；`--fix-rounds` 覆盖轮数，`0`=关闭
- `02-fix-plan`（修复方案设计）增加 `confirm: true`，`--interactive`/`--remote` 下方案先确认再动代码
- SKILL.md 技能契约扩展为双流水线：新增需求路由规则（修复类需求走修复流水线）、修复流 5 阶段角色表与输出格式模板

### Changed
- `watch-issues.js` 触发修复流水线改用 `--pipeline fix --requirement`（原 `--amend` hack 移除）；每个 Issue 的产物写独立 `<work-dir>/issue-<N>/`，互不覆盖；`github.json` 的 `maxFixRounds` 透传为 `--fix-rounds`（此前配置了但从未实现）
- `prompts/issue-01-analysis.md` 输入源改为上下文输入 `artifacts/00-requirement.md`（兼容 Issue 原文与用户直接描述）；`prompts/issue-04-fix-test.md` 要求报告末行输出 `VERDICT: PASS|FAIL` 结论标记

## [1.0.0] - 2026-11-05

> 重置版本线，从 1.0.0 重新迭代

### Changed
- 此前 1.0.0–2.1.2 的变更记录保留在「历史归档（重置前）」区

## 历史归档（重置前）

> 以下条目属于重置前的版本线，仅作追溯，不参与当前版本线；标题已降级以免与当前版本冲突。

### [2.1.2] - 2026-11-05

> 确认角色名为产品规划引导师，统一订正规格笔误并修复 SKILL.md 版本不一致

### Fixed
- 角色名统一为产品规划引导师，移除 SKILL.md / README.md 的漏字待确认说明与 agents.json 的括号备注
- SKILL.md frontmatter 的 version 被手工改成 0.1.1，按权威 meta.json 同步回 2.1.1

### 本次归档的待办记录
- SKILL.md frontmatter 的 version 被手工改成 0.1.1，与权威 meta.json 2.1.1 不一致
- 确认阶段 1 角色名应为「产品规划引导师」，规格中的角色名漏字，需统一订正

### [2.1.1] - 2026-11-05

> 按技能契约对齐 7 阶段与 7 角色，补齐目标、输入、执行步骤、输出格式与约束

### Added
- SKILL.md 新增技能契约章节：目标、输入、工作流与角色、执行步骤、输出格式、约束

### Changed
- config/agents.json 的 7 个角色名对齐规格，角色提示词加入不编造、缺失项与假设点约束
- README.md 阶段表增加当前执行角色与 agent id 列

### Fixed
- 01-product-plan 与 02-requirements 原共用 product-manager，新增 requirement-analyst 专用于需求拆解
- 交付汇报未按阶段分条输出，补齐分阶段输出格式与覆盖 7 阶段的全流程汇总

### 本次归档的待办记录
- 工作流要求每个阶段由指定角色执行，但 01-product-plan 与 02-requirements 共用 product-manager，与规格不符
- SKILL.md 缺少目标/输入/工作流与角色/执行步骤/输出格式/约束的完整技能契约，且交付汇报未按阶段分条输出

### [2.1.0] - 2026-11-05

> 新增版本号管理与迭代机制，支持使用中问题记录、语义化发版与多宿主副本盘点

### Added
- scripts/version.js 与 scripts/lib/version.js：check/sync/note/bump/installed/log
- CHANGELOG.md：SemVer 规则、Unreleased 待办区与迭代闭环
- scripts/lib/platforms.js：五宿主安装位置共享定义

### Changed
- 安装器改为从 meta.json 读取唯一权威版本，并在版本不一致时给出警告

### Fixed
- SKILL.md 与 watch-issues.js 中无效的 --daemon 示例参数

### 本次归档的待办记录
- SKILL.md 与 watch-issues.js 注释仍写 --daemon，但实现从未解析该参数，容易误导使用者

### [2.0.0] - 2026-11-05

> 多平台兼容升级：让同一份 skill 可安装到 WorkBuddy / CodeBuddy / zCode / Marvis / Qoder 并被各宿主正确驱动。

### Added

- 新增 `scripts/install.js`：五宿主用户级 / 项目级一键安装、`--link` / `--force` / `--uninstall` / `--dry-run`，自动生成各平台元数据
- 新增 `references/platform-compat.md`：五平台发现路径、frontmatter 差异、CLI 方言与安装验收清单
- 适配层引入「宿主 host / 适配器 adapter」分离，支持 `AGENT_PIPELINE_HOST` 与 `*_CLI_CMD` 覆盖，新增 WorkBuddy、zCode、Qoder、Marvis 命令映射
- 新增 `--timeout-ms` 参数；演练模式在缺少 agent CLI 时降级为占位 runner，只告警不退出
- `README.md` 扩充为完整使用手册

### Changed

- `SKILL.md` 改用多平台公共 frontmatter，新增「在宿主中如何执行」章节，移除宿主专属变量占位符
- `config/agents.json` 默认模型改为跨宿主可移植的 `auto`，回退候选改由宿主 `models.json` 动态发现
- `watch-issues.js` 状态文件与流水线产物迁出 skill 安装目录，统一写 `--work-dir`
- `.gitignore` 补充运行时产物与状态文件

### Fixed

- 五个 Issue 修复流提示词要求「写入输出文件」与编排器 stdout 落盘冲突，统一为 stdout 输出
- `config/agents.json` 注释声称模型已改回 `auto` 但数据仍是 `custom-local:*`，注释与数据对齐
- 项目级安装目标若落在源码目录内会递归复制，安装器增加拒绝检查
- `--platform all,common` 组合报「未知平台」，改为支持 `all` / `auto` 与具体平台混合

### [1.0.0] - 2026-10-16（重置前版本线，与当前 1.0.0 无关联）

> 初始版本。

### Added

- 七阶段主流水线编排（产品规划 → 需求拆解 → 架构设计 → 开发编码 → 代码审查 → 测试 → 部署）
- CLI 适配层：CodeBuddy / Claude Code / Codex / plain 四种方言
- 人工确认、远程确认（exit 42）、断点续跑、限额自动切换模型
- 需求构建器（7 维度引导 → A/B 双版本）、GitHub Issue 自动修复循环、git 拉取项目辅助脚本
