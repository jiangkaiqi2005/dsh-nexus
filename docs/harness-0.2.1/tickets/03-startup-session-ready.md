# 03：启动自动接通等待会话列表就绪

**要构建的行为：** 开启「启动后自动接通」时，Host 把自动接通交给某个页面后，该页面在客户端会话列表就绪（列表里有 `nexus-supervisor`）后再打开主会话并接通，不再因 `sessions.retain: unknown session nexus-supervisor` 显示「通话失败 · UNAVAILABLE」。

**阻塞于：** 01。

**状态：** 待实施。

**范围与约束：** 依据 Spec R9 与裁定 7。

- 只改 `client.js` 中 `claimStartup()` 之后打开主会话的流程。用宿主公开的就绪信号（例如会话列表的 phase / 列表内容）等待，不用固定次数的盲目重试；等待有上限，超时仍走现有失败态。
- 自动接通只消费一次的语义不变。

- [ ] `startup.test.mjs`「native default and save, new Host cycles…」通过，连续重跑 3 次都通过。
- [ ] 其余 `startup` 用例（权限、设备、播放、模型失败）保持通过。
- [ ] `npm run typecheck`、`npm test` 全套：除 R8 对应用例外全部通过。

**Spec 对照：** 诊断结论 R9；裁定 7。
