# 03：启动自动接通等待会话列表就绪

**要构建的行为：** 开启「启动后自动接通」时，Host 把自动接通交给某个页面后，该页面在客户端会话列表就绪（列表里有 `nexus-supervisor`）后再打开主会话并接通，不再因 `sessions.retain: unknown session nexus-supervisor` 显示「通话失败 · UNAVAILABLE」。

**阻塞于：** 01。

**状态：** 实施完成，首轮双轴评审（d9f574b）两轴均 approve；[验证记录](../verification/03-startup-session-ready.md)。等待的是原生会话列表 `ctx.sessions.list` 中出现 `nexus-supervisor`（上限 10 秒）。

**范围与约束：** 依据 Spec R9 与裁定 7。

- 只改 `client.js` 中 `claimStartup()` 之后打开主会话的流程。用宿主公开的就绪信号（例如会话列表的 phase / 列表内容）等待，不用固定次数的盲目重试；等待有上限，超时仍走现有失败态。
- 自动接通只消费一次的语义不变。

- [x] `startup.test.mjs`「native default and save, new Host cycles…」通过，连续重跑 3 次都通过。
- [x] 其余 `startup` 用例（权限、设备、播放、模型失败）保持通过。
- [x] `npm run typecheck`、`npm test` 全套：除 R8 对应用例外全部通过。

**Spec 对照：** 诊断结论 R9；裁定 7。

**评审遗留（协调者裁定不修）：** 页面卸载后等待不随 `uiCtx` 取消（最多残留 10 秒订阅与定时器，之后跳过 `openSession`，行为正确）；`limit = 10000` 默认参数只有一个调用方；`disposed` 连判两次。均为低严重度判断题，按简单优先不再开修复轮。另两项不属于本票：全套中 `profile` 组 Host 提前退出（票 01 的 RESPONSE_FAILED、本票的 TIMEOUT，3 次全套出现 2 次，与 `client.js` 无关），以及失败后 `autoPending` 仍为 true、用户再打开主会话会自动接通（修复前已存在）——两者列为后续跟踪。
