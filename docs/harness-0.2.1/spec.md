# 适配 DeepSeek Harness 0.2.1-rc.2 Spec

状态：2026-10-17 诊断完成，用户授权由协调者自行裁定（"所有决策你自己决定"），尚未实施。依据：[领域词汇](../../CONTEXT.md)、[级联语音 Spec](../cascade-voice/spec.md)、[前端打磨 Spec](../ui-polish/spec.md)。不新增领域概念，不新增 ADR。进度见 [tickets](tickets.md)。

## 问题陈述

用户的 Desktop 已升级到 DeepSeek Harness **0.2.1-rc.2**（Cordis 4.0.5、schemastery 3.18.5）。Nexus 0.2.0 在新版上不可用：

- `package.json` 的 `@deepseek-ai/dsh*` peer 精确锁定 `0.2.0-rc.2`。新版 `dsh-app-boot` 的 `evaluatePluginCompatibility` 会拒绝 `dsh plugin add`（"Plugin dsh-nexus@0.2.0 is incompatible with dsh 0.2.1-rc.2"），启动时 `loadProfileDirectory` 也会跳过该 bundle，所以用户 `desktop` profile 里已装的 Nexus 不再加载。
- 只把版本号改成 0.2.1-rc.2 后：`tsc` 0 错误，Desktop 自带 CLI 能安装并端到端跑通 cascade-install、clean-install；但单元测试 150 项中 20 项失败（旧版基线 0 失败）。

## 诊断结论（根因）

逐项复现与证据见诊断报告（协调者会话 scratch，关键事实已抄录于此）。

| 根因 | 新版变化 | 受影响 | 归属票 |
| --- | --- | --- | --- |
| R1a | 设置入口移进「账号菜单」→ menuitem「设置」 | 测试夹具 | 01 |
| R1b | 无头浏览器首启弹出「预览版说明」与「开始使用」登录弹窗（`dsh-client-ui-settings-models` 的 `credentialOnboarding`，真实 Desktop 窗口不显示），「稍后配置」消失 | 测试夹具 | 01 |
| R2 | `ctx.subagents.startContinuable` → `startActivation({ ..., delivery })`；`drainContinuableChildren` → `drainChildren` | 测试探针 `dispatch-probe.js`、`delivery-probe.js` | 01 |
| R3 | 后台作业 id 从 `pwsh-17` 变成 `pwsh-<16 位十六进制>` | 测试探针 `steering-probe.js` | 01 |
| R4 | 主管每次请求固定部分多约 1.8k token（新原生工具 `schedule_*`、`working_directory`，`harness-dev-context` 加长） | 压缩测试的预算与历史长度 | 01 |
| R5 | 有活跃轮次时正常退出，supervisor 自己写入 `turn/end` `{kind:'aborted', reason:{kind:'disposed'}}`，不再是重启后补的 `interrupted` | 恢复测试断言 | 01 |
| R6 | 挂断上行与下一通 `call()` 竞争：`src/voice.ts` 的 `owner` 只在生成器 finally 里释放，立即重拨得到 `CALL_BUSY` | **插件代码** | 02 |
| R7 | `dsh-base` 原生标题 `maxOutputTokens` 从 64 改为 4096，`src/work-session-titles.ts` 的补丁变成空操作 | 插件代码（删除） | 01 |
| R8 | 当前模型不在模型目录时，新版模型选择器显示「请选择模型」而不是 `${provider}/${model}`；Realtime 模式下 Nexus 输入框因此显示误导文案 | **插件代码**（用户可见） | 04 |
| R9 | 启动自动接通：`claimStartup()` 为 true 后 `uiWorkspace.openSession(SUPERVISOR)` 抛 `sessions.retain: unknown session nexus-supervisor`（客户端会话列表尚未就绪），被吞成 `UNAVAILABLE` | **插件代码** `client.js` | 03 |

另：`archive.test` 的 profile 重复挂载 `@deepseek-ai/dsh-schedule`（新版 `dsh-web-app` 已自带），日志报 `service "schedule" has been registered`，去掉重复行（01）。

## 裁定（协调者 2026-10-17，经用户授权）

1. **只支持 0.2.1-rc.2 及以后的 0.2.x。** 不保留 0.2.0-rc.2 兼容：子代理 API 与设置入口都是不兼容变化，双兼容要在测试里写分支。
2. **peer 改为区间**：所有 `@deepseek-ai/dsh*` peer 写 `>=0.2.1-rc.2 <0.3.0-0`（`-0` 让开启 includePrerelease 的兼容门也拒绝 0.3.0 预发布版），并新增 `engines.dsh` 同一区间（新版兼容门有 `engines.dsh` 时只看它）；`@deepseek-ai/cordis` 写 `^4.0.5`，`@deepseek-ai/schemastery` 写 `^3.18.5`。devDependencies 精确写 0.2.1-rc.2 / 4.0.5 / 3.18.5，重新生成 `package-lock.json`。插件版本升到 **0.2.1**。
3. **R4 只改测试**（调高预算并加长历史）。是否从主管工具集过滤 `schedule_*`、`working_directory` 与 `harness-dev-context` 是独立的产品优化，不在本批。
4. **R5 接受新版的 `aborted(disposed)`**，不改插件。
5. **R7 删除** `src/work-session-titles.ts` 及其接线与专属测试/断言。
6. **R6 在 Host 侧修**：收到挂断上行时立即释放 `owner`；若仍有竞争，`call()` 遇到占用可等待不超过 500ms 再回 `CALL_BUSY`。真实占线照常报。
7. **R9 等会话列表就绪再打开主会话**，不用盲目重试；失败仍走现有失败态。
8. **R8 让 Nexus 输入框显示真实 Realtime 模型名**，且该模型不得出现在其他会话的模型列表中。若公开 API 做不到，实施代理报告并停在"需人工关注"，不做 hack。
9. **测试首启弹窗**：在测试 profile patch 里设 `@deepseek-ai/dsh-client-ui-settings-models` 的 `credentialOnboarding: false`（并按需设置预览版说明已读），与真实 Desktop 行为一致；不依赖 `page.addLocatorHandler`。
10. 不提交工作区里与本批无关的 `promo/`、`.claude/`、`skills-lock.json`。

## 不变的部分

- Nexus 的领域行为、上下行协议、状态码、UI 视觉一律不变（R8 只改模型名显示）。
- 测试断言的行为不降低：改的是定位方式、夹具与随新版语义变化的期望值，每处都要能对应到上表根因。

## 测试决定

- 每张票完成后跑 `npm run typecheck`、`npm test` 全套；票 01 之后预期只剩 R6、R8、R9 对应的失败，之后每张票各消掉一类。
- 最终跑 `NEXUS_DESKTOP_SMOKE=1 node --test --test-concurrency=1 tests/desktop.test.mjs tests/cascade-install.test.mjs tests/clean-install.test.mjs`，用 `D:/DeepSeekHarness` 自带的 0.2.1-rc.2 CLI 安装打包产物。
- README（中英）与 `docs/installation-and-use.md` 的版本要求更新为 0.2.1-rc.2 / Cordis 4.0.5。
