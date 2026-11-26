# 五平台兼容参考

本文件记录 `agent-pipeline` 在 WorkBuddy / CodeBuddy / zCode / Marvis / Qoder 上的发现路径、元数据格式、安装差异与验证方式。`SKILL.md` 只保留必要摘要，详细差异集中在此，按需加载。

## 1. 公共基线：Agent Skills 开放标准

五个宿主都识别「一个目录 + 目录内 `SKILL.md`」这一结构。唯一必需的 frontmatter 字段：

```yaml
---
name: agent-pipeline
description: 做什么 + 何时触发
---
```

- `name` 必须为小写 kebab-case，且**与安装目录名一致**（zCode 强制校验，1–64 字符）。本 skill 的安装目录固定为 `agent-pipeline`。
- `description` 是唯一的自动触发信号，需同时写清「做什么」和「哪些场景用」。zCode 的 skill-creator 明确建议写得偏主动，否则模型容易漏触发。
- 未知 frontmatter 字段会被各宿主忽略，因此 `version` / `display_name` / `allowed-tools` 等扩展字段可安全共存。

> 本文件只讨论 **skills 安装路径**。执行链路与宿主无关：任何宿主只要能把工单正文交给自己的 Agent 执行、并把输出回写到 `handoff/results/`，就能驱动本流水线。

**不要**在 `SKILL.md` 正文里使用 `${CODEBUDDY_SKILL_DIR}` 之类的宿主专属变量：CodeBuddy 会在加载时替换，其余宿主不会，导致同一份文档行为不一致。统一用 `<SKILL_DIR>` 文字占位，并要求宿主 Agent 先定位 `SKILL.md` 所在目录。

## 2. 发现路径矩阵

| 宿主 | 用户级 | 项目级 | 优先级 / 备注 |
|------|--------|--------|--------------|
| WorkBuddy | `~/.workbuddy/skills/<name>/` | `.workbuddy/skills/<name>/` | 列表展示名优先读 `_skillhub_meta.json` 的 `name` |
| CodeBuddy | `~/.codebuddy/skills/<name>/` | `.codebuddy/skills/<name>/` | 官方文档明确两级路径；项目级优先于用户级 |
| zCode | `~/.zcode/skills/<name>/`、`~/.agents/skills/<name>/` | `.zcode/skills/<name>/`、`.agents/skills/<name>/` | 项目级 > 用户级；`.zcode/skills` 优先于 `.agents/skills`（同名时前者覆盖）；官方推荐把跨工具 skill 放 `.agents/skills/` |
| Marvis | `~/.marvis/skills/custom/<name>/` | 不支持 | `skills/market/` 属于市场包目录，自建 skill 必须放 `custom/`；`meta.json` 必需 |
| Qoder | `~/.qoder/skills/<name>/`；国内版 `~/.qoder-cn/skills/<name>/` | `.qoder/skills/<name>/` | 也可用 `npx skills add ... -a qoder` 安装；同名冲突时项目级优先 |

`.agents/skills/` 是跨工具通用发现点（Codex / Cursor / Cline / zCode 等），安装脚本把它作为可选平台 `common`，需要一份安装被多个工具共用时使用：`--platform common`。

> 本机实测（macOS，2026-11-05）：`~/.workbuddy/skills`、`~/.codebuddy/skills`、`~/.marvis/skills/{custom,market}`、`~/.qoder-cn/skills`、`~/.agents/skills` 均存在；`~/.qoder`、`~/.zcode` 存在但尚无 `skills/` 子目录（安装器会创建）。

## 3. frontmatter 与元数据差异

| 宿主 | 读取的 frontmatter 扩展字段 | 目录内元数据文件 | 安装脚本行为 |
|------|---------------------------|-----------------|-------------|
| WorkBuddy | `version`、`display_name`、`display_name_en`、`description_zh`、`description_en` | `_skillhub_meta.json`（市场安装时生成） | 写入兼容子集 + `_skillhub_meta.json` |
| CodeBuddy | `allowed-tools`、`context: fork`、`agent`、`model`、`user-invocable`、`hooks` | `_skillhub_meta.json` / `_meta.json` | 写入 `allowed-tools` + 两套元数据 |
| zCode | 保留字段（如 `metadata.author` / `metadata.version`），通常只需 `name` + `description` | 无 | 只写标准字段，元数据文件可安全忽略 |
| Marvis | 无特殊要求 | `meta.json` **必需**：`name` / `display_name` / `description` / `detail_describe` / `display_description` / `author` / `version` / `type` / `scope` / `source` | 复制并同步 `version` |
| Qoder | 无特殊要求 | `metadata.json` 可选（市场索引信息） | 写入精简 `metadata.json` |

`allowed-tools` 仅在 CodeBuddy 生效，用于允许 skill 执行 `Bash` 调用编排脚本；其他宿主忽略该字段，仍按各自的权限模型询问用户。

## 4. 执行方式：基于宿主程序本身

流水线本身不产生 AI 能力，**执行完全基于宿主程序本身**，不启动任何外部进程。`scripts/lib/host-adapter.js` 把每个阶段的任务正文写成工单，然后以**退出码 3** 交还执行权；宿主用自身的派发能力执行，回写结果后重跑即可推进。

| 文件 | 用途 |
|------|------|
| `handoff/orders/<stageId>--<agentId>.order.md` | 工单正文：角色、提示词、上下文入参、证据与输出格式要求 |
| `handoff/queue.json` | `pending`（`key` / `promptHash` / `stageId`）与 `history`，用于去重与作废 |
| `handoff/results/<key>.result.md` | 宿主回写结果（`host-queue.js submit --file`） |
| `handoff/done/` | 消费后成对归档的工单与结果（`keepDone` 控制保留量） |
| `handoff/executions/` | 阶段结果缓存，重跑直接重放，不重复派发 |

各宿主的差异只体现在「谁来执行工单」，与命令参数无关：

| 宿主 | 执行工单的方式 |
|------|----------------|
| Marvis | 主 Agent 用 `dispatch_task` 派子 Agent，输出写文件后 `host-queue.js submit` |
| WorkBuddy / CodeBuddy / zCode / Qoder | 宿主 Agent 读工单正文执行，回写后重跑编排器 |
| 任意自定义宿主 / 离线自测 | `--host-script <js>` 注入进程内响应器（导出 `respond(prompt, ctx)` 返回正文字符串） |

环境变量只剩一个与执行相关：`AGENT_PIPELINE_FAKE_SCRIPT`（等价于 `--host-script`，供自动化脚本使用）。不再有 `AGENT_PIPELINE_HOST` / `AGENT_PIPELINE_ADAPTER` / `*_CLI_CMD` 之类的命令行探测变量。

> 同一轮推进请固定 `--work-dir`；工单键为「阶段--角色」，任务正文变化会触发 `promptHash` 不一致，旧工单自动标记 `superseded` 并归档。

## 5. 安装与验收

```bash
# 1) 演练，确认目标路径
node <SKILL_DIR>/scripts/install.js --dry-run

# 2) 用户级安装到本机所有已检测宿主
node <SKILL_DIR>/scripts/install.js --platform auto --scope user

# 3) 项目级安装并纳入版本库（团队共享）
node <SKILL_DIR>/scripts/install.js --platform all --scope project --project-root /path/to/repo

# 4) 验收：阶段链与提示词演练（不出工单、不派发）
node <SKILL_DIR>/scripts/run-pipeline.js --project-name smoke-test --dry-run --work-dir /tmp/ap-smoke
```

验收清单：

1. 每个目标目录存在 `SKILL.md`，且 `name` 为 `agent-pipeline`，目录名一致。
2. Marvis 目标目录存在 `meta.json`；WorkBuddy / CodeBuddy 目标存在 `_skillhub_meta.json`。
3. 重启宿主或执行 `/skills reload` 后，skill 出现在可用列表里；用「帮我把这个需求自动编排到开发完成」验证触发。
4. `--dry-run` 只校验阶段链与提示词配置，不出工单、不需要任何外部工具；正式运行按第 4 节走工单派发。
5. 运行时 `artifacts/`、`logs/`、`data/` 只出现在 `--work-dir`，安装目录保持干净。

## 6. 已知限制

- **安装目录可能只读**：市场安装的 skill 常被平台托管。定制请用 `--work-dir` 下的同名模板/配置覆盖，或直接修改源码后重新安装，不要写安装目录。
- **本地安装不会自动同步到远端工作机**：云端 / 远程执行环境需把 skill 作为项目级文件提交，或在目标机单独安装。
- **宿主能力不等价**：Qoder / Marvis 等宿主可能没有子 Agent 或 Bash 权限，`--agent/--agents`、工具白名单、`effort`、`maxTurns` 不生效；流水线会降级为顺序角色回合，产物质量依赖宿主自身能力。
- **触发依赖 description**：若宿主不自动触发，可显式说明「使用 agent-pipeline skill」，或检查该宿主是否支持 skill 自动发现。
- **同名冲突**：项目级通常覆盖用户级（zCode 的 `.zcode/skills` 还优先于 `.agents/skills`）。多份安装共存时，用 `--uninstall` 清理不需要的那份。
