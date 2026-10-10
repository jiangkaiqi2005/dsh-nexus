# 票 13：派活以用户消息发出并自动命名会话验证

2026-10-10，按本次明确授权实施票 13，依据 ADR 0004。实施基点为 `195444d`（票 12 收尾提交，票 10 已关闭，满足票据“待 10 完成后执行”）。没有推送、PR、打包安装或发布，没有读取真实凭据或调用付费模型，也没有操作用户现用 Desktop / profile（`~/.dsh`）。未改动票 12 的压缩代码。

## 行为与边界

- **派活来源：** `nexus_send_session` 与 `nexus_create_session` 投递的原生消息来源由 `nexus-dispatch` 改为 `{ kind: 'user', via: 'nexus', supervisorId, callId }`（`src/work-sessions.ts`，`MessageSourceMap` 键 `nexus-dispatch-user`）。`via: 'nexus'` 是“经由 Nexus”的标记，`supervisorId` 是主管会话身份，`callId` 是发出该派活的工具调用；字段随原生 `user/message` 与 `agent/inbox/spliced` 完整落盘，可直接阅读。正文就是工具参数 `text`，不加转述前缀。投递路径不变：运行中走原生 `steer`，闲置走 `followup`。
- **识别：** `isNexusDispatch` 同时识别新形态（`kind: 'user'` 且 `via: 'nexus'`）与票 13 以前落盘的 `kind: 'nexus-dispatch'`；旧来源的类型声明保留，用于读取旧日志。结果回流（`src/results.ts`）只把对话会话中“`kind: 'user'` 且不带 Nexus 标记”的输入当作用户直接引导同步给主管；工作会话的轮次终态照常作为 `nexus-work-result` 回流，与派活来源无关。旧派活原本就不是 `user` 来源，从未被同步，本票只是把新形态一并排除。
- **主管识别自己的派活：** 主管系统指令（`src/realtime.ts`）补一句：工作会话记录中来源带 `via nexus` 的用户消息、以及较旧的 `nexus-dispatch`，是主管自己的派活，不是用户的直接输入（`nexus_read_session` 返回的记录含来源字段）。
- **新建会话命名：** Nexus 不起标题、不调用重命名。派活成为 `user` 来源后，原生 `dsh-session-title` 按普通会话处理：会话在派活前无标题（界面“未命名”）；派活被领取为 `user/message` 后，原生先写取开头几个词的兜底标题（`source: fallback`），再在该会话的首个主请求之后用该请求的模型路由生成标题（`source: provider`，首条提示词命名器 `session-title-first-prompt-llm`）。
- **已有会话：** 原生首条提示词命名只在“非子会话、该会话第一条 user 输入、尚无标题”时触发，兜底标题只在无标题时写入，所以已有标题的会话被派活不改标题；Nexus 不补旧的未命名会话。按原生规则推断（未专门测试）：只有旧派活、尚未命名的会话以后若再收到新形态派活，这条派活是它的第一条 `user` 输入，原生会像普通会话一样为它命名；本票把“不补”理解为不回填，不阻止这种原生命名，待裁定。
- **主会话名：** 主管会话进入原生会话表后（`src/index.ts`），若当前无标题或最新标题只是原生兜底（`source: fallback`），调用原生 `sessionTitle.rename(session, 'Nexus')`；标题来源为 `user`、`model`/`provider` 时保留。原生重命名记为 `source: user`，这也是原生唯一能在无 user 消息时写入的标题形态，并会锁定标题，此后主会话中的用户输入不再派生兜底标题。用户在 Desktop 改名同样经 `sessionTitle.rename` 记为 `source: user`，重启时不被覆盖。为此插件新增注入 `sessionTitle` 与 peer 依赖 `@deepseek-ai/dsh-session-title@0.2.0-rc.2`（Desktop 的 `dsh-base` 已装载该服务）。
- **ADR 0004 的后果：** 原生按 `user` 来源统计或处理的行为现在也计入派活，例如会话列表的最近输入时间 `lastPromptAt`（证据中 Nexus 新建会话有值，只有旧派活的 `legacy-worker` 为 null）、`api-session/activity`、派活正文中的 `@会话` 引用解析、goal 工具的“本轮有用户输入”判断。浏览器时区上下文只读取带 `rpcId` 的消息，不受影响。

最高验证边界：隔离的官方 `dsh --profile nexus-titles --port 0 --no-open` 加载实际插件，三次启动同一 `DSH_HOME`，原生会话落盘与原生 `dsh-session-title`（`dsh-base` 配置：兜底 5 词 / 40 字节、首条提示词命名器），第四次启动不加探针，用真实 headless Edge 打开官方 Web 客户端（与 Desktop 同一套客户端代码）。Realtime 主管为本地受控 WebSocket（fixture 凭据），按脚本发出派活工具调用；工作会话模型与命名模型是测试插件登记的受控原生适配器 `title-worker`（命名请求按原生 `purpose: 'session-title'` 返回 `Title <首条消息前 24 字>`）。未调用真实 DashScope、DeepSeek 或真实命名模型。受控端点通过不等于 Desktop 实机侧栏与真实命名模型。

证据在忽略目录 `.scratch/nexus-v1/`：`titles-*` 目录含 `phase-1/2/3.json`（每次启动的主管落盘事件、各工作会话事件、会话列表投影、工作模型实际收到的用户文本）、`result.json`（加脚本发出的工具调用与界面无障碍快照）、`ui-created.png`、`ui-legacy.png` 与原生 sessions；`ticket13/` 下是各次命令输出。

## 逐项验证

| 验收条目 | 实际观察与断言 | 限制 |
| --- | --- | --- |
| 新建会话先“未命名”，随后原生自动命名；派活显示为用户输入 | `nexus_create_session` 新建的会话：派活 `user/message` 之前没有任何 `session/title`；之后依次为兜底 `run-titled-new: 实现登录页并写测`（`fallback`，40 字节截断）与 `Title run-titled-new: 实现登录页并写测`（`provider`，`session-title-first-prompt-llm`）；会话列表投影标题同后者。Web 客户端侧栏显示该标题；打开会话后派活正文以普通用户消息显示（文本 + 时间 + 复制），与用户亲自输入的消息形态相同，没有“收到执行请求”。对照：只有旧 `nexus-dispatch` 派活的 `legacy-worker` 在侧栏为“未命名”，会话内显示为折叠的“收到执行请求”。 | 命名模型为受控适配器；Desktop 程序中的侧栏未实机。 |
| 运行中与闲置的已有会话派活均成功，标题不变 | `titled-idle`（闲置）工具结果 `delivery: followup`，`titled-busy`（运行中，保持在第 1 步等待引导）`delivery: steer`，两者都执行了派活（最终回复 `Worker executed: <派活原文>`）；两者 `session/title` 始终是派活前的兜底 + 模型标题两条，三次启动后不变。第二次启动后向已命名的新建会话再派活，标题同样不变。 | — |
| 派活不回流为用户引导；用户亲自输入照常同步；新旧派活重启后不回流、不重复 | 三次启动后主管落盘日志中，`nexus-user-input` 恰好对应工作会话里全部 4 条用户亲自输入（两个已有会话的初始输入、新建会话中第一次与第二次启动各一条），各一次；5 条派活（第一次启动 3 条、第二次 1 条新形态，加 1 条旧 `nexus-dispatch`）的消息 id 都不在其中；`nexus-work-result` 按会话与轮次无重复，旧派活会话的轮次结果照常回流。中继单元测试：新形态 steer / 排队与旧形态都不同步，同一会话用户输入照常同步，重建中继后重放与新到的两种派活都不同步。 | — |
| 主会话名为 Nexus；用户手动改名后重启不覆盖 | 首次创建即为 `Nexus`（`source: user`）；第一次运行末尾模拟旧 Desktop 日志，在主管日志追加兜底标题 `PHASE-ONE dispatch`，第二次启动改回 `Nexus`；第二次运行末尾经原生 `sessionController.rename` 改为 `我的管家`，第三次启动保持 `我的管家` 且启动时不追加任何事件；主管日志的标题序列为 Nexus → 兜底 → Nexus → 我的管家，其间主会话三次用户输入都没有派生兜底标题。Web 客户端侧栏显示 `我的管家`。 | 用户 Desktop 主会话现有标题未读取（遵约束），见下文复核 4。 |
| 工作 agent 收到的派活正文与 Nexus 发出的一致，无前缀 | 落盘 `user/message` 正文与工具参数 `text` 逐字相等；工作模型第一次请求中 `user` 来源的文本恰好是 `["run-titled-new: 实现登录页并写测试"]`；来源对象恰为 `{ kind: 'user', via: 'nexus', supervisorId: 'nexus-supervisor', callId: <该工具调用 id> }`。 | — |

## 已知事实复核

1. **原生命名只接受 `user` 来源，旧派活会话无标题：** 属实。`@deepseek-ai/dsh-session-title` 0.2.0-rc.2 的 `sessionTitleUserMessageOf` 只取 `source.kind === 'user'` 的 `user/message`，其不变量也要求自动标题引用的消息为 `user` 来源。修改前的受控证据 `dispatch-controlled-1791660528067` 中 Nexus 新建会话没有任何 `session/title`；本票界面对照中旧派活会话为“未命名”，正文显示为折叠的“收到执行请求”。补充：自动命名在首条 `user` 输入后、该会话的首个主请求开始时才启动，模型路由默认取该主请求的路由；兜底标题先于模型标题出现。
2. **来源可扩展，`user` 来源可带额外字段并完整落盘：** 属实。`MessageSourceMap` 可合并扩展，Host 自身的 `user-rpc` 为 `{ kind: 'user', rpcId, clientTimeZone? }`；本票字段经第三次启动的冷读（`sessionController.inspect` 读落盘日志）原样读回。Host 中对 `user` 来源的特殊处理（上传回执、时区、提示去重）都以 `rpcId` 存在为前提，派活不带 `rpcId`，不受影响。
3. **结果回流把所有 `user` 来源视为用户直接引导：** 属实（修改前 `isDirectUserInput` 只判断 `kind === 'user'`）。新单元测试在修改前失败：新形态的两条派活被同步（`2 !== 0`）。
4. **主会话当前标题是早期测试消息形成的兜底标题：** 未在用户 Desktop 上复核（不读取 `~/.dsh`）。代码层面成立：修改前 Nexus 不写标题，主会话的用户输入是 `user` 来源，原生会为其写兜底标题；手动改名记为 `user`，兜底记为 `fallback`，模型标题记为 `provider`，三者由 `session/title.data.source.kind` 区分。本票按“无标题或兜底”改名，其余保留。

## 检查与证据

- 红测试 `ticket13/red-results.txt`：新增中继用例失败（`2 !== 0`），12 项既有用例通过。实现后 `ticket13/green-results.txt` 13 passed / 0 failed。（`red-results.txt` 为修正测试中一处重建后误用旧中继的笔误后的重跑结果；修正前同样失败于该断言。）
- Host 级红测试 `ticket13/red-titles.txt`：在只改派活来源、尚无主会话命名的构建上运行，第一次启动报告主会话标题为 `null`（证据 `titles-1791661529619/phase-1.json`），派活、命名与回流部分已如预期；该次随后因测试端点在第二次启动的脚本取会话 id 方式有误而中断，改为由探针在提示中给出 id。加入主会话命名后 `ticket13/green-titles.txt` 首次 1 passed（证据 `titles-1791661766466`）；其间两次失败都是测试断言问题（期望同步列表遗漏了两个已有会话的初始用户输入；一处字段访问错误），未改产品代码。
- 加入 Web 客户端检查：`ticket13/titles-ui-1.txt` 失败于首启对话框遮罩拦截点击（改为持续关闭对话框直到侧栏稳定），`ticket13/titles-ui-2.txt`、`ticket13/titles-ui-3.txt` 失败于测试正则转义错误（`\d` 被写成 `d`），按 `titles-1791662539083/result.json` 中的快照核对修正后的正则匹配。
- 相关测试 `ticket13/related-tests.txt`（`dispatch`、`delivery`、`steering`、`workspace`、`results`）：20 项，17 passed / 0 failed / 3 skipped（真实端点用例）。这些测试中对派活来源的断言由 `kind === 'nexus-dispatch'` 改为新形态。
- `ticket13/typecheck.txt`、`ticket13/build.txt` exit 0；`git diff --check` 无输出。

- 加入界面检查后单独连跑两次 `ticket13/titles-ui-fix-1.txt`、`ticket13/titles-ui-fix-2.txt`：均 1 passed（证据 `titles-1791662963119`、`titles-1791662995531`）。

全量 `npm test`，三次，失败证据保留：

1. `ticket13/npm-test-1.txt`（尚无界面检查）：92 项，80 passed / 1 failed / 11 skipped，374.8 s，exit 1。失败的是本票新用例：第一次启动的 Host 进程在约 10 s 内退出，没有任何错误输出，也没写报告（证据 `titles-1791661857041` 只有各会话头部，事件尚未落盘）。当时的断言消息没有记录退出码；此后改为在消息中带出退出码与信号。该现象之后在单独运行（7 次）与另两次全量中均未再现，原因未查明。
2. `ticket13/npm-test-2.txt`：92 项，80 passed / 1 failed / 11 skipped，367.1 s，exit 1。失败的仍是本票用例，在第四次启动的界面检查：首启对话框的“继续”按钮处于禁用状态随后被移除，点击等待 30 s 超时（三次 Host 启动部分均已通过）。改为只尝试点击 1 s 并继续循环关闭对话框后，上述单独连跑两次通过。
3. `ticket13/npm-test-3.txt`：92 项，81 passed / 0 failed / 11 skipped，365.6 s，exit 0（本票证据 `titles-1791663031046`）。比票 12 最终全量（90 项）多出本票 2 项（中继单元 1 项、Host 1 项）；11 项 skipped 是套件既有的 10 项真实端点与 1 项 Desktop 显式启用验证，没有计作通过。

```powershell
npm run typecheck
npm run build
node --test tests/results.test.mjs
node --test tests/titles.test.mjs
npm test
git diff --check
```

## 未验证与待用户验收

- Desktop 程序中侧栏的实际标题（新建会话的自动命名、主会话显示 Nexus 或用户改的名称）与派活在会话中的显示，待用户实机验收；本票只以官方 Web 客户端代码在 headless Edge 中验证。
- 真实命名模型：Desktop 的命名默认使用工作会话主请求的模型（如 `deepseek-flash`），本票用受控适配器，未调用真实模型，标题内容与语言风格未验证。
- 用户 Desktop 主会话当前标题的实际来源（复核 4）。
- 本票未运行 `NEXUS_DESKTOP_SMOKE=1` 的 Desktop 打包冒烟（它会 `npm pack` 并用 Desktop 自带 CLI 安装到隔离 profile；本次约束不打包安装）。新增的 `sessionTitle` 注入在 Desktop 运行时由 `dsh-base` 提供，安装前建议按惯例跑一次冒烟。
- 真实模型下主管是否据来源标记正确辨认自己的派活（读取会话记录时），未用真实模型验证。
