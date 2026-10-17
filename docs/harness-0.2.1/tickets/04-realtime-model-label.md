# 04：Realtime 模式输入框显示真实模型名

**要构建的行为：** Realtime 模式下，Nexus 主会话输入框的模型按钮显示实际使用的 Realtime 模型（如 `qwen3.8-omni-flash-realtime`），不显示「请选择模型」；该模型不出现在其他会话的模型选择列表里。

**阻塞于：** 01。

**状态：** 待实施。

**范围与约束：** 依据 Spec R8 与裁定 8。

- 先核实新版 `dsh-client-ui-model-selection` 显示模型名所依赖的模型目录来源，以及 Host/客户端可用的公开注册方式。
- 用公开 API 实现；若做不到"只让 Nexus 认得、别的会话看不到"，停止并报告「需人工关注」，附证据与候选方案，不做 DOM 改写等 hack。
- 级联模式的显示不变。

- [ ] `ui.test.mjs`「Nexus footer opens an enabled native composer…」通过（读到真实模型名）。
- [ ] 有断言证明普通工作会话的模型列表里没有 Realtime 模型。
- [ ] `npm run typecheck`、`npm test` 全套通过（opt-in 跳过除外）；`NEXUS_DESKTOP_SMOKE=1` 三项冒烟通过。

**Spec 对照：** 诊断结论 R8；裁定 8；测试决定。
