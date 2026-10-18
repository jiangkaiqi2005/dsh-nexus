# 04：Realtime 模式输入框的模型显示

**要构建的行为：** 原目标是让 Realtime 模式下 Nexus 输入框显示真实模型名，但公开 API 做不到（见验证记录）。按 Spec 裁定 8 的补充裁定：接受新版原生回退「请选择模型」；测试锁定这个回退，并证明 Realtime 模型不出现在其他会话的模型目录里。

**阻塞于：** 01。

**状态：** 实施完成，首轮双轴评审（3b9fc87）两轴均 approve。曾停在需人工关注（公开 API 做不到「只让 Nexus 认得、别的会话看不到」），按补充裁定改为锁定原生回退；证据、上游需求草稿与检查结果见[验证记录](../verification/04-realtime-model-label.md)。

**范围与约束：** 依据 Spec R8 与裁定 8。

- 先核实新版 `dsh-client-ui-model-selection` 显示模型名所依赖的模型目录来源，以及 Host/客户端可用的公开注册方式。
- 用公开 API 实现；若做不到"只让 Nexus 认得、别的会话看不到"，停止并报告「需人工关注」，附证据与候选方案，不做 DOM 改写等 hack。
- 级联模式的显示不变。

- [x] `ui.test.mjs`「Nexus footer opens an enabled native composer…」通过：Realtime 模式下断言原生回退「请选择模型」（依据补充裁定，替代原来的"读到真实模型名"），其余断言不降低。
- [x] 有断言证明普通工作会话的模型列表里没有 Realtime 模型。
- [x] `npm run typecheck`、`npm test` 全套通过（opt-in 跳过除外）；`NEXUS_DESKTOP_SMOKE=1` 三项冒烟通过。

**Spec 对照：** 诊断结论 R8；裁定 8；测试决定。

**评审遗留（协调者裁定不修）：** 「新建会话」定位写法与 `cascade-lifecycle.test.mjs:106` 不一致（`.first()` 与 `exact: true` 加 `.last()`，两者都能用）；`tests/ui.test.mjs:82` 注释带批次编号 `R8:`；夹具模型名用正则而不是精确字符串；回退文案分不清"选了目录外模型"和"根本没选"（`source.model` 断言已经证明实际用的是 Realtime 模型）。均为低严重度判断题。Realtime 模式下 Nexus 的模型按钮仍可点开选目录里的模型，这是原生行为，本票未处理。
