# 通过 Marvis 触发 CodeBuddy 开发工作流

> 本说明面向用户侧：你只需要在 Marvis 对话框里说一句话，Marvis 会自动调用 `D:\nodejs\code\workflows` 下的编排脚本执行完整开发流水线。
>
> **当前交互约束**：你不在电脑边，所有交互（确认、提意见、看产物、决定下一步）全部通过 Marvis 对话框进行，无需也不应触碰终端。

## 触发链路总览

```
你的一句话（需求/地址/指令）
        ↓
Marvis 识别意图（启动开发 / 拉取代码 / 修订 / 监听 Issues / 演练）
        ↓
shell_executor 执行 workflows 脚本（--remote 远程确认模式）
        ↓
CodeBuddy CLI 多 Agent 多模型流水线（规划→架构→开发→审查→测试→部署）
        ↓
confirm 阶段产出后：脚本暂停（exit 42 + 写 artifacts/.confirm-state.json）
        ↓
Marvis 读取状态文件 → 在对话框转述产物摘要 → 问你要不要确认 / 有什么意见
        ↓
你在对话框回复（确认 / 修改意见）→ Marvis 以 --from / --amend 续跑
        ↓
循环直到流水线跑完，产物落盘 + 日志摘要返回给你
```

## 远程模式（人不在电脑边，推荐）

- 所有运行统一加 `--remote`：到达需确认的阶段（01 产品规划、02 需求拆解）时，脚本不会停在终端等人输入，而是写 `artifacts/.confirm-state.json` 后以退出码 42 结束。
- Marvis 会读取该状态文件，把当前阶段产物整理成摘要发到对话框，并等你回复：
  - 回复「确认 / 可以 / 继续」→ Marvis 从下一阶段续跑；
  - 回复具体修改意见 → Marvis 用 `--from <阶段> --amend "<意见>" --remote` 让 agent 按意见重跑该阶段，再交给你确认。
- 你全程只动嘴（打字），不需要碰电脑。

## 触发场景与话术

### 1. 新项目从零开始（无现有代码）

- 你：「帮我开发一个 XXX 项目，功能是……」
- Marvis 动作：
  1. 将需求写入 `artifacts/00-requirement.md`
  2. 运行 `node scripts/run-pipeline.js --project-name <项目名> --remote`
- 说明：项目目录自动创建在 `D:\nodejs\code\<项目名>`；远程模式下 01 产品规划 / 02 需求拆解产出后自动暂停，由 Marvis 把产物摘要发给你，你在对话框确认或提意见后继续。

### 2. 基于已有仓库开发（拉代码 + 全流程）

- 你：「拉取 https://github.com/xxx/yyy.git 并开始开发，我的需求是……」
- Marvis 动作：
  1. 运行 `node scripts/init-project.js --url https://github.com/xxx/yyy.git --name <项目名>`
     - 目录自动落在 `D:\nodejs\code\<项目名>`（`--name` 缺省取仓库名）
     - 分支缺省优先 `DEV` / `dev` / `develop`，否则取第 1 位远程分支
  2. 将需求写入 `artifacts/00-requirement.md`
  3. 运行 `node scripts/run-pipeline.js --project-name <项目名> --remote`

### 3. 需求讨论细化（交互引导模式）

- 你：「先做产品分析和需求拆解，跑完停下来等我确认」
- Marvis 动作：`node scripts/run-pipeline.js --project-name <项目名> --remote --init-only`
- 说明：只跑前置段（01 PRD + 02 需求清单），到确认点暂停，Marvis 把产物发到对话框供你逐条讨论。

### 4. 按修订意见更新产物

- 你：「把 PRD 按我的意见改一下：增加离线模式……」
- Marvis 动作：`node scripts/run-pipeline.js --project-name <项目名> --from 01-product-plan --amend "增加离线模式……" --remote`

### 4b. 远程确认 / 驳回 / 提意见

- 你（看到 Marvis 转述的产物后）：「确认，继续」或「第 3 点不对，改成支持多端同步」
- Marvis 动作：
  - 确认 → `node scripts/run-pipeline.js --project-name <项目名> --from <下一阶段> --remote`
  - 提意见 → `node scripts/run-pipeline.js --project-name <项目名> --from <当前阶段> --amend "<你的意见>" --remote`，重跑后再次转述给你确认

### 5. 断点续跑 / 指定阶段范围

- 你：「需求确认过了，从架构阶段继续跑」
- Marvis 动作：`node scripts/run-pipeline.js --project-name <项目名> --from 03-architecture`
- 你：「只跑开发和测试」
- Marvis 动作：`node scripts/run-pipeline.js --project-name <项目名> --from 04-develop --to 06-test`

### 6. 先演练（不真正执行）

- 你：「先演练一遍，看看会执行什么」
- Marvis 动作：`node scripts/run-pipeline.js --project-name <项目名> --dry-run`
- 说明：只打印每阶段将执行的命令与模型，不调用 CodeBuddy，适合上线前检查。

### 7. GitHub Issue 修复闭环

- 你：「开始监听 xxx 仓库的 Issues，有问题就自动修复」
- Marvis 动作：`node scripts/watch-issues.js --daemon`（常驻监听）或 `--once`（单次检查）
- 前置条件：`config/github.json` 填好 `owner / repo / token`（或设 `GITHUB_TOKEN` 环境变量）；首次运行会建立基线，之后新 Issue 进入 01-05 修复流水线。

## 触发词对照表

| 你的意图 | 推荐话术示例 | Marvis 执行 |
|---|---|---|
| 新项目开发 | "帮我开发一个 XX 项目，功能是……" | 写需求 → `run-pipeline.js --interactive` |
| 拉仓库开发 | "拉取 <git地址> 开始开发，需求是……" | `init-project.js` → 写需求 → `run-pipeline.js --interactive` |
| 只做前期分析 | "先做产品分析和需求拆解" | `run-pipeline.js --interactive --init-only` |
| 按意见修订 | "按我的意见改 PRD：……" | `run-pipeline.js --from 01 --amend "……"` |
| 断点续跑 | "从架构阶段继续" | `run-pipeline.js --from 03-architecture` |
| 指定范围 | "只跑开发和测试" | `run-pipeline.js --from 04-develop --to 06-test` |
| 演练检查 | "先演练一遍" | `run-pipeline.js --dry-run` |
| 监听 Issues | "监听 xxx 仓库 Issues 并自动修复" | `watch-issues.js --daemon` |
| 模型限额切换 | （无需你操心） | 内置 `fallbackModels` 自动切换 |

## 注意事项

1. **远程交互方式**：所有运行加 `--remote`，confirm 阶段由 Marvis 中转确认；你只需要在对话框回复「确认」或具体意见，不要也不要尝试操作电脑终端。
2. **CLI 就绪**：本机已装 `@tencent-ai/codebuddy-code@2.164.0`，首次使用需在终端执行 `codebuddy` 完成账号登录（复用登录态）。
3. **开发目录固定**：所有项目落在 `D:\nodejs\code\<项目名>`，无需手动传目录。
4. **分支策略**：拉取仓库默认优先 `DEV` 系分支，不使用 MASTER。
5. **模型限额**：执行中遇到 quota / 429 等过载，编排器自动按 `fallbackModels` 切换候选模型（在 `config/agents.json` 的角色下配置，按切换顺序填自定义模型 ID）。
6. **权限参数**：脚本默认带 `--dangerously-skip-permissions`，仅在可信项目中运行。
7. **日志**：每次运行写入 `logs/pipeline.log`，产物在 `artifacts/`。
8. **状态文件**：远程模式暂停点记录在 `artifacts/.confirm-state.json`，Marvis 凭它判断从哪个阶段续跑；确认后该文件会被下一次运行覆盖。
*（内容由AI生成，仅供参考）*
