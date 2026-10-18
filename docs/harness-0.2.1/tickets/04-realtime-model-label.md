# 04：Realtime 模式输入框的模型显示

**要构建的行为：** 原目标是让 Realtime 模式下 Nexus 输入框显示真实模型名，但公开 API 做不到（见验证记录）。按 Spec 裁定 8 的补充裁定：接受新版原生回退「请选择模型」；测试锁定这个回退，并证明 Realtime 模型不出现在其他会话的模型目录里。

**阻塞于：** 01。

**状态：** 按补充裁定继续实施（测试与文档）。原先停在需人工关注的原因：公开 API 做不到「只让 Nexus 认得、别的会话看不到」，未改代码；证据与候选方案见[验证记录](../verification/04-realtime-model-label.md)。

**范围与约束：** 依据 Spec R8 与裁定 8。

- 先核实新版 `dsh-client-ui-model-selection` 显示模型名所依赖的模型目录来源，以及 Host/客户端可用的公开注册方式。
- 用公开 API 实现；若做不到"只让 Nexus 认得、别的会话看不到"，停止并报告「需人工关注」，附证据与候选方案，不做 DOM 改写等 hack。
- 级联模式的显示不变。

- [ ] `ui.test.mjs`「Nexus footer opens an enabled native composer…」通过：Realtime 模式下断言原生回退「请选择模型」（依据补充裁定，替代原来的"读到真实模型名"），其余断言不降低。
- [ ] 有断言证明普通工作会话的模型列表里没有 Realtime 模型。
- [ ] `npm run typecheck`、`npm test` 全套通过（opt-in 跳过除外）；`NEXUS_DESKTOP_SMOKE=1` 三项冒烟通过。

**Spec 对照：** 诊断结论 R8；裁定 8；测试决定。
