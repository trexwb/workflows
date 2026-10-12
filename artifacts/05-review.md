# 代码审查报告（Code Review）：node-demo

> 审查对象：`D:\nodejs\code\node-demo`（已实现代码）
> 对照基线：`artifacts/03-architecture.md`（主）、`artifacts/PRD.md`、`artifacts/02-tasks.md`
> 审查维度：正确性、可读性、安全性、性能、与架构一致性、编码风格
> 验证环境：Node v22.21.0（Windows）；`npm test` 结果 **29 passed / 0 failed，退出码 0**；`npm ci --dry-run` 成功
> 说明：本报告只报告经代码阅读与实测确认的事实，不夸大。

---

## 一、概览

| 项 | 内容 |
|----|------|
| 审查范围 | `src/` 5 个模块、`test/` 4 个测试文件、`package.json`、`package-lock.json`、`README.md`、`.gitignore`、`.github/workflows/ci.yml` |
| 文件数 | 源码 5 + 测试 4 + 配置/文档 5 = 14 个审查对象 |
| 实测结果 | `npm test` 29/29 通过、退出码 0；`npm ci` 可正常校验 lockfile |
| 总体评价 | 实现与架构文档高度一致：模块分层清晰、纯函数与 I/O 分离到位、零第三方依赖、HTTP/CLI 数据契约符合设计、错误响应不泄露堆栈、路径穿越校验正确。存在 1 个高严重级缺陷（非法 PORT 退出码错误，fail-fast 失效）与 1 个中严重级架构一致性偏差（模块导入期注册进程级兜底，破坏“零副作用导入”契约），另有若干低级别健壮性/风格/覆盖缺口。整体质量良好，建议修复高/中两项后即可交付。 |

---

## 二、问题列表

### 高严重级

#### H1. 非法 PORT 启动时退出码为 0，fail-fast 失效
- **文件**：`src/server.js`（第 149 行、第 162–168 行、第 170–176 行）
- **问题描述**：
  `startServer` 的默认参数 `port = resolvePort(process.env.PORT)` 在进入函数体之前同步求值。当 `PORT=abc` 或 `PORT=70000` 时，`resolvePort` 抛出异常，此时 `startServer()` 调用本身同步抛出、尚未返回 Promise，因此第 172 行的 `.catch(...)` 永远不会执行。该异常被第 163–165 行的模块级 `uncaughtException` 处理器捕获并仅记录日志，随后事件循环无待处理句柄，进程自然退出。
  **实测结果**（Node v22.21.0）：
  - `PORT=abc node src/server.js` → 退出码 `0`
  - `PORT=70000 node src/server.js` → 退出码 `0`
  即：非法端口没有按架构 R9 / §6.1“非法 PORT 直接抛错退出（fail-fast）”及 README“启动即报错退出”承诺以非零退出码结束，而是以成功码 0 静默结束，且服务未启动。依赖退出码的脚本/CI 会误判为成功。
- **具体修改建议**（推荐第一种）：
  1) 将端口解析移入 `startServer` 函数体内，确保抛错发生在 Promise 链内可被 `.catch` 捕获：
  ```js
  function startServer(port) {
    const resolvedPort = port === undefined ? resolvePort(process.env.PORT) : port;
    const server = createServer();
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(resolvedPort, () => { /* ... */ });
    });
  }
  ```
  2) 若保留默认参数写法，则在入口判定处用 `try/catch` 包裹同步调用并 `process.exit(1)`：
  ```js
  if (require.main === module) {
    try {
      startServer().catch((err) => { logger.error('failed to start server', err); process.exit(1); });
    } catch (err) {
      logger.error('failed to start server', err);
      process.exit(1);
    }
  }
  ```
  建议同时补一条测试：断言 `startServer` 在非法端口下以可捕获的方式失败（而非进程级吞掉）。
