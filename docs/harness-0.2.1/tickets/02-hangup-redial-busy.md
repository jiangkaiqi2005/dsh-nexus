# 02：挂断后立即重拨不再误报占线

**要构建的行为：** 同一窗口挂断后立刻再次接通，不会得到「另一个窗口正在通话」（`CALL_BUSY`）；另一个窗口真实占线时照常报 `CALL_BUSY`。

**阻塞于：** 01。

**状态：** 实施完成，待评审；[验证记录](../verification/02-hangup-redial-busy.md)。证据表明仅「收到挂断即释放」仍有竞争，因此同时加了 500ms 内的等待。

**范围与约束：** 依据 Spec R6 与裁定 6。

- 优先在 Host 侧 `src/voice.ts`：收到挂断上行时立即释放 `owner`，不必等生成器 finally；释放必须幂等，不能让旧通话的收尾误释放新通话的占用。
- 仅当上述修改后仍有竞争，再让 `call()` 遇到占用时等待不超过 500ms 后再判定 `CALL_BUSY`。
- 不改协议与状态码。

- [x] `cascade-tap.test.mjs`「hangup and client disconnect abort recognition…」通过，连续重跑 3 次都通过。
- [x] 真实占线（另一个客户端持有通话）仍报 `CALL_BUSY`，有测试覆盖。
- [x] `npm run typecheck`、`npm test` 全套：除 R8、R9 对应用例外全部通过。

**Spec 对照：** 诊断结论 R6；裁定 6。
