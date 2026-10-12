架构设计文档已写入 `artifacts/03-architecture.md`，与 `PRD.md`、`02-tasks.md` 同目录，可直接进入编码阶段。

**核心设计决策速览：**

| 维度 | 决策 | 理由 |
|------|------|------|
| 模块系统 | CommonJS | `require.main === module` 入口判定对新手友好；`require('../package.json')` 让 `buildInfoBody` 保持零 I/O |
| 运行时 | Node ≥18，零第三方依赖 | 对齐 PRD NFR-C2 / AC2.3 |
| 测试 | `node:test` + `node:assert/strict` | `npm test` = `node --test` 自动发现 `test/*.test.js` |
| 模块 | 5 个：logger / core / stats / server / cli | 路由内联在 server.js，不抽 router，避免过度架构 |

**可落地关键点（文档已给出精确签名与骨架）：**
- `src/server.js` 导出 `resolvePort` / `createServer` / `startServer`，导入零副作用；`startServer(0)` 支持集成测试随机端口（对齐 PRD R3）。
- 统一错误处理三层兜底：handler try/catch → 500 JSON 不含堆栈、`res.on('error')` 防 EPIPE、进程级 `uncaughtException` 兜底。
- `stats.js` 拆 `countStats`（纯函数）+ `statFile`（I/O + `path.relative` 路径穿越校验），满足"纯函数可测"。
- 完整落盘目录树、HTTP/CLI 外部接口表、JSON 数据契约、`package.json` 与 `ci.yml` 全文、10 项风险权衡表、11 条开发者开工自检清单。

**需要你确认的一个取舍（R4，已在文档标注）：** PRD 称"`node:test` 自 18 起稳定"，实际 Node 18 的 test runner 可能输出实验性告警（不影响结果与退出码）。文档建议本地用 Node 20+，CI 矩阵保留 18 验证兼容下限——如果你希望 CI 只锁 20+，我可以调整。

下一步可让编码 Agent 按 `03-architecture.md` + `02-tasks.md` 的 T01→T12 顺序开工。