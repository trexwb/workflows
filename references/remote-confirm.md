# 远程人工决策协议（--remote / exit 42）

供外部驱动方（IM 机器人、其他 AI agent、定时任务看护进程）在不占用终端的前提下驱动整条流水线。默认项目经理模式使用 `pm-escalation.json`；只有旧配置（`projectManager` 缺失或 `enabled: false`）才使用 `.confirm-state.json`。

## 退出码与标记

| 退出码 | 含义 | stdout 标记 | 状态文件 |
|--------|------|-------------|----------|
| `0` | 完成、本次范围执行结束或用户取消 | 无 | 项目经理状态为 `complete` / `paused` / `cancelled` |
| `1` | 配置或状态错误 | 无 | 按错误处理 |
| `2` | 专业阶段或验收失败 | 无 | 项目经理状态通常为 `failed` |
| `42` | 等待人工决策 | `HUMAN_DECISION_NEEDED` | `artifacts/pm-escalation.json` |
| `42` | 旧配置等待阶段确认 | `REMOTE_CONFIRM_NEEDED` | `artifacts/.confirm-state.json` |

所有路径均相对 `--work-dir`。

## 一、项目经理人工升级（默认）

触发条件：项目经理判断涉及业务范围变化、生产发布、不可逆操作、新增授权、预算/工期重大取舍、阻塞问题豁免或证据冲突，超出其决策权限；返工预算耗尽也会生成升级包。

脚本执行步骤：

1. 保存当前状态、决策历史、失效产物与待处理升级包；
2. 写 `artifacts/pm-escalation.json`；
3. 打印 `HUMAN_DECISION_NEEDED`、决策包路径与恢复命令；
4. 非交互模式以退出码 **42** 结束。

### 状态文件 schema

```json
{
  "projectName": "demo-app",
  "projectDir": "<绝对路径由运行时解析，不在配置中硬编码>",
  "pipelineConfigRel": "config/pipeline.json",
  "stateFile": "artifacts/pm-project-state.json",
  "pending": {
    "decisionId": "human-1792920000000",
    "currentStageId": "05-code-review",
    "mode": "review",
    "reasonType": "manager-escalation",
    "action": "pending",
    "question": "是否接受临时风险？",
    "whyCannotDecide": "涉及业务风险豁免，项目经理无权决定。",
    "options": ["拒绝并修复", "接受临时风险并记录遗留问题"],
    "recommendation": "拒绝并修复",
    "impact": "影响上线范围与剩余风险。",
    "evidence": ["artifacts/05-review.md 的 C1 问题"],
    "resumeStageId": "04-develop",
    "recommendedAmend": "拒绝风险豁免，修复 C1 后重新提交审查与测试证据。",
    "workOrder": {
      "objective": "修复审查问题并恢复验证",
      "requiredChanges": ["修复 C1"],
      "acceptanceChecks": ["审查与测试提供可复现证据"],
      "constraints": ["不扩大业务范围"],
      "outOfScope": ["无关重构"]
    },
    "createdAt": "2026-11-25T12:00:00.000Z"
  }
}
```

`reasonType` 为 `rework-budget` 时，恢复会自动追加一轮单阶段与总返工预算。`workOrder` 可选；若存在，会与人工决定一起注入 `resumeStageId` 指定阶段。退回更早阶段时，该阶段及下游产物、已完成验收结论会失效。

### 外部驱动循环

```text
run: node run-pipeline.js --project-name P --work-dir W --remote
loop:
  if exit == 0:
    向用户汇报本次结果；若状态为 paused，可按状态继续，否则结束
  if exit == 42:
    escalation = 读 W/artifacts/pm-escalation.json
    if escalation.pending 存在:
      向用户完整转述 question / whyCannotDecide / options /
      recommendation / impact / evidence / resumeStageId
      收集人工决定，得到明确指令后执行：
        node run-pipeline.js --project-name P --work-dir W \
          --resume-human <pending.decisionId> --amend "<人工决策原文>"
      回到 loop
    else:
      按旧版确认协议处理 .confirm-state.json
  if exit == 1/2:
    反馈错误原文；修复后用 --from <失败阶段> 断点续跑
```

恢复约束：

- `--resume-human` 的 ID 必须等于当前 `pm-project-state.json` 中 `pending.decisionId`。
- 必须同时提供 `--amend "<人工决策原文>"`；推荐方案可直接使用 `pending.recommendedAmend`。
- 恢复时不要重复传 `--requirement` 或显式 `--from`，否则会开启新的管理运行，而不是恢复当前升级。
- 恢复保留原项目状态、决策历史、失效产物与已花返工预算。
- 非交互恢复中的 `--amend` 是给专业角色的修订指令，不是“取消项目”开关；要停止项目，应在 `--interactive` 终端应答中选择停止，或由外部驱动方中止后续运行并保留产物。

## 二、旧配置阶段确认

仅当流水线没有 `projectManager`，或设置 `projectManager.enabled=false` 时生效。

当某个 `confirm: true` 的专业阶段（开发流默认 01 产品规划、02 需求拆解；修复流默认 02 修复方案）产出后，脚本：

1. 写 `<work-dir>/artifacts/.confirm-state.json`；
2. 打印 `REMOTE_CONFIRM_NEEDED`；
3. 以退出码 **42** 结束。

### 状态文件 schema

```json
{
  "projectName": "demo-app",
  "projectDir": "<运行时解析路径>",
  "stageId": "01-product-plan",
  "stageName": "产品规划",
  "output": "artifacts/01-prd.md",
  "nextStageId": "02-requirements",
  "action": "pending",
  "updatedAt": "2026-10-12T12:00:00.000Z"
}
```

驱动方使用三个字段：`output` 是本轮产物，`nextStageId` 是确认后的续跑阶段，`stageId` 是提修改意见时要重跑的阶段。

```text
确认类回复:
  node run-pipeline.js --project-name P --work-dir W --remote --from <nextStageId>
  （nextStageId 为 null 时，重跑最后阶段确认退出码）

修改意见:
  node run-pipeline.js --project-name P --work-dir W --remote \
    --from <stageId> --amend "<用户意见原文>"
```

`--amend` 只作用于 `--from` 指定的阶段，且必须与 `--from` 成对出现。

## 三、与 GitHub Issue 监听器衔接

`watch-issues.js` 识别项目经理升级退出码 42，把结果记录为 `awaiting-human`，并打印对应 Issue 工作目录下的 `artifacts/pm-escalation.json` 路径；不会把等待人工记成普通失败，也不会自动修改 GitHub Issue 远端状态。驱动方应先完成人工决策，再按第一节命令恢复。

## 四、与需求构建器衔接

`req-builder.js --build/--select` 的 `--remote` 使用独立协议：每步完成后写 `<work-dir>/artifacts/.req-state.json`（`step: built | selected`），驱动方按 `step` 提示用户下一步（选版本 → 启动流水线）。它不使用项目经理升级包。

## 五、状态文件时效

确认或恢复完成后，状态文件会被更新为 `idle` / `resolved` / `cancelled`，或由下一暂停点覆盖。驱动方读取后应立即处理，不要依赖其长期存储；审计需要保留 `pm-decisions.md`、`pm-project-state.json` 与人工回复记录。
