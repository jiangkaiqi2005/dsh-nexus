# DeepSeek Harness 实现前置核查

核查日期：2026-10-08。范围为 Nexus 插件的版本、安装形式、自定义 Agent 登记、原生 Session 持久化与恢复，以及可参考的上游测试。本轮只读取官方源码、文档与 npm 元数据；没有安装依赖、启动 Harness、执行探针或编写插件实现。本文中的“源码确证”表示读到对应实现，“建议路线”表示这些接口的组合推断，尚无本项目运行证据。

## 版本基线

固定参考仓库为 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，commit 为 [5badb15009ae1756c3afe0ae0cef1faafc290ccc](https://github.com/deepseek-ai/deepseek-harness/commit/5badb15009ae1756c3afe0ae0cef1faafc290ccc)，提交时间 2026-10-03T03:48:13Z。本地只读副本位于 `E:\Agent\dsh-nexus\.scratch\deepseek-harness`。根包和所查 Harness 包版本为 `0.2.1-alpha.1`，Node 要求为 `^22.19.0 || >=24.0.0`；源码版本依据为 [根 package.json](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/package.json#L1-L10)。官方仍声明 developer preview 和兼容性变化，见 [README](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/README.md#L9-L13)。

2026-10-08 查询官方 npm Registry 得到以下发布信息。这是查询时快照，标签会变化；后续实现应固定精确版本而非依赖 `latest` 或 `alpha` 标签。

| 包 | 查询时 latest | 查询时 next | 本文对应发布版本 |
|---|---|---|---|
| `@deepseek-ai/dsh` | `0.2.0-rc.2` | `0.2.0-rc.2` | `0.2.1-alpha.1`，alpha 标签 |
| `@deepseek-ai/dsh-agent` | `0.1.0-rc.6` | `0.2.0-rc.2` | `0.2.1-alpha.1`，alpha 标签 |
| `@deepseek-ai/dsh-session` | `0.0.1-rc.1` | `0.2.0-rc.2` | `0.2.1-alpha.1`，alpha 标签 |
| `@deepseek-ai/dsh-session-persistence` | `0.0.1-rc.1` | `0.2.0-rc.2` | `0.2.1-alpha.1`，alpha 标签 |
| `@deepseek-ai/dsh-llm` | `0.0.1-rc.1` | `0.2.0-rc.2` | `0.2.1-alpha.1`，alpha 标签 |
| `@deepseek-ai/cordis` | `4.0.4` | `4.0.1-rc.4` | `4.0.5-alpha.1`，`dsh-0-2-1-alpha-1` 标签 |

一手元数据：[dsh](https://registry.npmjs.org/@deepseek-ai%2Fdsh)、[agent](https://registry.npmjs.org/@deepseek-ai%2Fdsh-agent)、[session](https://registry.npmjs.org/@deepseek-ai%2Fdsh-session)、[persistence](https://registry.npmjs.org/@deepseek-ai%2Fdsh-session-persistence)、[llm](https://registry.npmjs.org/@deepseek-ai%2Fdsh-llm)、[Cordis](https://registry.npmjs.org/@deepseek-ai%2Fcordis)。所查 alpha 发布元数据未给出 `gitHead`，因此只能确定版本号对应，不能宣称 npm 产物与上述 commit 字节一致。`dsh-agent@0.2.1-alpha.1` 的 npm peers 为精确 `0.2.1-alpha.1` 的 Harness 包与 `@deepseek-ai/cordis ~4.0.5-alpha.1`。

**前置决定建议：**以这一 commit 的接口写 Spec，未来验收也固定同一版本线。不得用默认 `npx` 取得的 rc.2 Host 来替代 alpha.1 接口验证。若最终选择 rc.2 交付，应重新核对本文涉及接口，不能仅换版本字符串。

## 插件分发与依赖

官方现成骨架是一个普通 ESM bundle：`package.json` 声明 `dsh.bundle.patch`，补丁插入 Host plugin row；Host 模块采用 `apply(ctx, config)` 或默认 Service 类，服务依赖由 `inject` 明确表达。UI 部分增加 `dsh.client` 和 `./client` 导出。已有 [Host 插件参考](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/preset/agent-preset/skills/cordis-plugin-development/references/host-plugin.md) 与 [最小 UI bundle manifest](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/preset/agent-preset/skills/cordis-plugin-development/templates/decoration/package.json)，无需另造应用启动器。本文没有执行模板复制或安装。

真实产品集成应由已有 `web` / Desktop profile 加载 Nexus bundle；`dsh` 是官方唯一受支持的 Node 应用入口。CLI 管理形式为 `dsh plugin --profile <name> <pnpm args>`；Web Plugin Manager 支持安装本地绝对路径 bundle。Desktop 使用自己的 bundled CLI 管理已初始化的 `desktop` profile，npm CLI 不负责该保留 profile。来源：[CLI README](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/apps/cli/README.md)、[Plugin Manager](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/boot/plugin-manager/README.md#L31-L65)。安装及启动会检查插件声明的 DSH peer ranges，版本不兼容并非只会产生 pnpm 警告。

依赖要区分 Host 已提供的运行服务与独立项目的编译类型：

| 用途 | 对应包与公开入口 | 前置结论 |
|---|---|---|
| Context、effects、插件生命周期 | `@deepseek-ai/cordis` | 与 Host 的 Cordis 版本一致；本基线为 `4.0.5-alpha.1`。 |
| 自定义主管接口与登记 | `@deepseek-ai/dsh-agent` 主入口 | `Agent`、`Inbox`、`AgentOptions`、`agentEvents`、registry 的 Context augmentation。 |
| 原生事件、Session 及恢复修补 | `@deepseek-ai/dsh-session` 主入口 | `SessionId`、`Session`、`SessionEvent`、`SessionPreparation`、`interruptedTurnClosers`。 |
| 原生写所有权与读写句柄 | `@deepseek-ai/dsh-session-persistence` | `SessionPersistence`、`SessionHandle`、create/open options。 |
| 原生消息与工具消息类型 | `@deepseek-ai/dsh-llm` | `UserMessage`、消息构造及 provider/model 来源；使用原生事件时需要这一词汇。 |
| 主管自己的作用域 | `@deepseek-ai/dsh-scope` | `createScope(ctx, agent)` 与其 disposer；避免把主管注册贡献留在全局。 |
| 读取/注册派生状态 | `@deepseek-ai/dsh-session-projection` | 默认 loop 的 inbox / turnBoundary 等投影需要明确依赖和兼容处理。 |

上述 Harness 包在本文源码基线均为 `0.2.1-alpha.1`。这是实现所需接口包清单，不是已经确定的最终依赖树：独立 TypeScript 项目需要对应开发类型；分发包应声明真正依赖的 DSH peers 与兼容版本。官方 Host-only JS 模板可以没有 npm runtime dependencies，已随 dsh 分发的包由安装环境解析，不能为得到类型而重复加载第二套 Host 服务。依据：[插件开发参考](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/preset/agent-preset/skills/cordis-plugin-development/SKILL.md)、[agent package exports/peers](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent/package.json)、[持久化 package](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/session/session-persistence/package.json)。

Nexus 不应把 `@deepseek-ai/dsh-agent-loop` 作为自己的扩展接口依赖；官方明确扩展依赖 service definition `dsh-agent`，具体 loop 可替换。后端 `dsh-session-persistence-jsonl` 由真实 Host composition 提供，Nexus 消费抽象 `sessionPersistence`。上游测试可以直接创建 Context 并挂载核心 runtime，这证明低层组装适合隔离测试；不意味着可以绕开 profile 把它作为受支持应用入口。来源：[core.md](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/subsystems/core.md#L20-L51)、[真实上游测试 fixture](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent-loop/tests/resume.spec.ts#L32-L56)、[应用入口架构](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/architecture.md#application-launch)。

## 自定义 Agent 的真实接口

`Agent` 是公开接口，身份 `id: SessionId` 与 Session 身份必须一致。运行面包括 `options`、`session`、`inbox`、`status`、`ctx`，以及 `cancel`、`whenIdle`、`runMaintenance`、`send`、`followup`、`steer`、`inject`。`Inbox` 也有公开读写契约，但没有在 `dsh-agent` 中提供一个可直接实例化的独立实现；默认实现属于 agent-loop。只实现一个简化对象后登记不能代表这些语义已经兼容。来源：[完整 Agent 运行接口](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent/src/runtime-types.ts#L164-L242)、[Inbox](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent/src/runtime-types.ts#L48-L100)、[身份类型](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent/src/types.ts#L15-L18)。

`ctx.agents.register(agent)` 将已构造 Agent 纳入 registry，并发送 startup creation announcement；它**不创建 Session、不登记 Session、不打开持久化写句柄，也不负责驱动实现**。高级 `enter` / `announce` 可以分开处理发布顺序。`setFactory` 只有一个槽位，第二次注册直接报错，因此不能同时注册“默认 worker factory”和“Nexus factory”两个独立工厂。建议保留默认工厂处理工作会话，主管作为插件持有的单独 Agent 登记；该建议尚未运行验证。来源：[register](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent/src/index.ts#L437-L442)、[setFactory](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent/src/index.ts#L358-L374)。

主管自己的 scope 可使用公开 `createScope`；默认 driver 也以 Agent 实例作 scope key。scope 定义注册可见性与释放生命周期，不能把一个任意全局 Context 当作同等替代。来源：[scope README](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/scope/README.md#L29-L42)、[默认 driver 构造](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent-loop/src/agent.ts#L121-L138)。

## 原生持久化的最小路径

**源码确证：**SessionStore 自身只提供内存会话。已发布 `session/event` 按 SessionId 路由到当前 active write handle，`session/flush` 是等待持久化及暴露写失败的屏障，handle close 会完成尾部 drain 并释放唯一写所有权。因此持有原生写句柄的自定义 Session 可以复用现有后端；没有写句柄就不会保存。上游有直接测试这一组合，无需经过默认 AgentLoop。来源：[后端事件路由源码](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/session/session-persistence-jsonl/src/storage.ts#L534-L566)、[live write contract](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/session/session-persistence/tests/live-write-contract.ts#L49-L86)、[持久化文档](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/subsystems/persistence.md#L7-L112)。文档“only agent-loop-published sessions persist”是在默认生命周期描述中的简写，不应据此忽略公开写句柄路径及其测试。

默认 loop 的新建源码路径为 `createAgent` → `sessions.prepare` → `sessionPersistence.create(session.header)` → 持久化未发布 seed/suffix → `setupAndPublish` → `prepare().publish`。其中 createStoredSession、setupAndPublish、prepare 是 **private**，只能参考，不是可供插件直接调用的 helper。来源：[createAgent](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent-loop/src/index.ts#L714-L780)、[createStoredSession](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent-loop/src/index.ts#L679-L706)。

**建议的自定义主管发布顺序：**由插件生命周期持有 Session preparation、原生 write handle 和 Nexus Agent；先完成配置/驱动准备与 seed 的写入，再 `sessions.enter`、`agents.enter`，接着 `sessions.announce`、`agents.announce`。参考默认发布路径时必须保留 rollback 与单写所有权；不要先在 UI 暴露半构造身份。退出时先停止驱动并等待 idle，完成 write handle close，再解除 Agent / Session 登记和 scope。此处是接口组合建议，尚未证明整个 Nexus 生命周期正确。来源：[默认 prepare / publish / dispose](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent-loop/src/index.ts#L479-L640)、[SessionStore enter](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/session/src/index.ts#L1081-L1115)、[announce](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/session/src/index.ts#L1136-L1164)。

持久化文本和工具调用应映射现有 `user/message`、`assistant/message`、`tool/call`、`tool/result` 和 turn/step 边界；`assistant/message` 要带原生 stream 记录，surface 消息需要准确 `surfaceOp`，不是往 JSONL 加一行任意聊天文本。自定义额外 log-only event 不会自动成为模型历史或聊天面板消息。来源：[Session event schema / surface rules](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/subsystems/session.md#L11-L310)、[projection 与 durable assistant settlement](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/architecture.md#L123-L129)。Realtime transcript、流增量、失败响应和 FC 应如何精确映射，仍需后续实现验证。

## 恢复边界

原生默认 `ctx.agents.resume` 会调用唯一已登记 factory；保留默认 agent-loop factory 时，冷恢复得到默认 ReactLoopAgent，而不是 Nexus 的自定义 Realtime driver。因此 Nexus 固定主会话需要在插件初始化时由自身打开原生存储并重建 driver，或在原生入口上明确处理 Nexus 身份，不能把 `resume` 调用写成“自动恢复同一个 Realtime 主管”。来源：[唯一 factory](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent/src/index.ts#L358-L374)、[默认 resume](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent-loop/src/index.ts#L807-L890)。

可复用原生恢复机制包括：先 `open(id, 'write')` 取得独占写权，再 read 物理完整事件，使用公开 `interruptedTurnClosers` 补齐丢失的工具/step/turn 收束，随后以 RestoredSessionOptions prepare。原生修补不承诺重跑中断任务。修补函数已从 session 主入口公开导出；自定义主管如何使用同一机制仍需验收，工作会话继续交给 Harness 原生恢复。来源：[resumeWith](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent-loop/src/index.ts#L816-L890)、[公开导出](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/session/src/index.ts#L27-L32)、[RestoredSessionOptions](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/session/src/types.ts#L165-L186)。这不增加自定义任务恢复、自动重试或强制续跑承诺。

## 上游测试先例与 Spec Testing Decisions

以下是已阅读的上游测试代码，**本轮没有执行**；它们证明上游对相应语义的明确断言，可参考测试层级与夹具，不能写为 Nexus 已通过测试。

| 范围 | 已读的上游断言 | 对 Nexus Spec 的参考 |
|---|---|---|
| Agent 登记 | [agent.spec.ts 68–95](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent/tests/agent.spec.ts#L68-L95)：登记原对象、roots 可见、重复身份拒绝、dispose 注销；AgentId 与 SessionId 不同拒绝。 | 最小 registry 测试应检验真实身份和释放，不只断言 register 被调用。 |
| Inbox / driver 事件 | [agent-loop agent.spec.ts 65–101](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent-loop/tests/agent.spec.ts#L65-L101)：exact inserted/claimed/discarded 消息；claimed 在 turn/start 之后。 | 若自定义 Inbox，应验证 pending持久化、来源保留、真实 claim/discard 边界。 |
| 持久化独立 seam | [live-write-contract.ts 49–86](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/session/session-persistence/tests/live-write-contract.ts#L49-L86)：Session+write handle路由落盘，没有handle不保存。 | 不应以聊天面板看到消息替代 durable log 检查。 |
| 新建/恢复持久化 | [resume.spec.ts 162–190](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent-loop/tests/resume.spec.ts#L162-L190)：seed与live turn保存且seq连续；[479–543](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent-loop/tests/resume.spec.ts#L479-L543)：fresh runtime恢复补齐interrupted工具/step/turn结果。 | 未来需真实关闭并重开存储，验证保存与恢复；不自动重跑中断工具。 |
| Host/UI事件与重连 | [transport.host.spec.ts 140–208](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/api/session-controller/tests/transport.host.spec.ts#L140-L208)：先replacement snapshot再live；cold read前订阅并忽略无关和已回放事件。 | 工作结果桥和Nexus面板要避免 snapshot/live重复及冷读期间丢事件。 |

上游隔离 fixture 直接创建 `Context`，挂载 LLM、SessionStore、SessionProjection、SystemPrompt、Tools、AgentRegistry、JSONL 后端、AgentLoop 与 MockAdapter。可用来理解必要服务及拆分测试，但 Nexus 自定义 driver 的测试不必挂载第二个 default factory；最终产品验收仍需真实 profile加载。来源：[mountPersistentHarness fixture](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent-loop/tests/resume.spec.ts#L32-L56)。

## 尚需在实现阶段回答

1. 自定义 Realtime driver 的 `Agent`、Inbox、turn/step/status/cancellation 与原生 projection / SessionController 是否完整兼容，尤其是 FC settlement 和 `agent/assistant-stream`。
2. Nexus主会话初始化是否能先于普通Session入口的cold resume完成；插件卸载、HMR、重复初始化和write owner冲突是否均不误启默认driver。
3. Qwen Realtime会话文本历史、工具历史、WS重连与原生日志如何保持一致；一个transport WS断开不等同Nexus持久会话或工作会话结束。
4. 插件依赖解析能否复用Host单例且peer版本一致；源码commit与发布alpha包没有gitHead关联的差异，需后续构建/真实安装检查。
5. 任意顶层工作会话结果投递仍需要Host bridge。原生父子subagent settle通知不能替代对所有顶层会话的订阅；挂断后的接收主体必须是Host插件。该桥不应强制每个结果触发播报或固定审查流程。

前四项属于实现前置接口核查后的验证缺口，不是本轮已发现的实现失败。第五项依据此前调研的 [原生 subagent 行为](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/subsystems/subagent.md)，产品行为仍按用户已确认的 Nexus设计。
