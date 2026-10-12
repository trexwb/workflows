# 远程确认协议（--remote / exit 42）

供外部驱动方（IM 机器人、其他 AI agent、定时任务看护进程）在不占用终端的前提下驱动整条流水线：脚本在需要人工确认的阶段**自行退出**，驱动方读状态文件 → 向用户转述 → 收集确认或意见 → 以正确参数续跑，循环直到完成。

## 核心机制

- 触发方式：`node <skill>/scripts/run-pipeline.js --project-name <项目名> --remote`
- 当某个 `confirm: true` 的阶段（默认 01 产品规划、02 需求拆解）产出后，脚本：
  1. 把暂停点写入 `<work-dir>/artifacts/.confirm-state.json`；
  2. 向 stdout 打印 `REMOTE_CONFIRM_NEEDED`；
  3. 以退出码 **42** 结束（仅 42 = 等待确认；0 = 完成；1 = 配置/CLI 错误；2 = 阶段执行失败）。

## 状态文件 schema

```json
{
  "projectName": "demo-app",
  "projectDir": "/abs/path/demo-app",
  "stageId": "01-product-plan",
  "stageName": "产品规划",
  "output": "artifacts/01-prd.md",
  "nextStageId": "02-requirements",
  "action": "pending",
  "updatedAt": "2026-10-12T12:00:00.000Z"
}
```

驱动方只关心三个字段：`output`（本轮产物路径，相对 work-dir）、`nextStageId`（确认后从哪继续）、`stageId`（提意见时重跑哪个阶段）。

## 驱动循环（伪代码）

```text
run: node run-pipeline.js --project-name P --remote
loop:
  if exit == 0:  流水线结束，向用户汇报产物清单，退出
  if exit == 42:
    state = 读 <work-dir>/artifacts/.confirm-state.json
    向用户转述 state.output 的内容摘要，提问：
      「回复“确认”继续；或直接给出修改意见」
    等用户回复：
      确认类（确认/可以/继续/OK）:
        run: node run-pipeline.js --project-name P --remote --from <state.nextStageId>
        （nextStageId 为 null 时即已到末尾，直接重跑最后一段验证退出码 0）
      修改意见:
        run: node run-pipeline.js --project-name P --remote \
               --from <state.stageId> --amend "<用户意见原文>"
        （该阶段会带着意见重新生成产物，再次 exit 42 等确认）
  if exit == 1/2:
    把 stderr/stdout 尾部原文反馈给用户；修复后用 --from <失败阶段id> 断点重跑
```

注意：`--amend` 只作用于 `--from` 指定的那一个阶段，且必须与 `--from` 成对出现。

## 对话话术映射（IM 场景示例）

| 用户说 | 驱动方动作 |
|---|---|
| 「帮我开发 XX 项目，需求是……」 | 把需求写入 `<work-dir>/artifacts/00-requirement.md`，然后 `--remote` 启动 |
| （收到 PRD 摘要后）「确认，继续」 | `--remote --from <state.nextStageId>` |
| （收到 PRD 摘要后）「第 3 点不对，改成……」 | `--remote --from <state.stageId> --amend "第 3 点不对，改成……"` |
| 「先只做产品分析和需求拆解」 | `--remote --init-only`（跑到最后一个确认点即停） |
| 「从架构阶段继续」 | `--remote --from 03-architecture` |
| 「只跑开发和测试」 | `--remote --from 04-develop --to 06-test` |
| 「先演练一遍」 | `--dry-run`（exit 0，无副作用） |

## 与需求构建器衔接

`req-builder.js --build/--select` 也支持 `--remote`：每步完成后写 `<work-dir>/artifacts/.req-state.json`（`step: built | selected`），驱动方按 `step` 字段提示用户下一步（选版本 → 启动流水线）。

## 状态文件的时效

确认完成后，下一次运行会覆盖 `.confirm-state.json`；驱动方读取后应立即处理，不要依赖其长期存储。若需要审计，把内容复制进自己的会话/存储。
