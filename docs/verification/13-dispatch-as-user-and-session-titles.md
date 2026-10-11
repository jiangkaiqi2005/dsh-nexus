# 票 13：派活以用户消息发出并自动命名会话验证

2026-10-10，按本次明确授权实施票 13，依据 ADR 0004。实施基点为 `195444d`（票 12 收尾提交，票 10 已关闭，满足票据“待 10 完成后执行”）。首轮实施阶段没有推送、PR、打包安装或发布，没有读取真实凭据或调用付费模型，也没有操作用户现用 Desktop / profile（`~/.dsh`）；后续冒烟及安装见各轮记录。未改动票 12 的压缩代码。

## 行为与边界

- **派活来源：** `nexus_send_session` 与 `nexus_create_session` 投递的原生消息来源由 `nexus-dispatch` 改为 `{ kind: 'user', via: 'nexus', supervisorId, callId }`（`src/work-sessions.ts`，`MessageSourceMap` 键 `nexus-dispatch-user`）。`via: 'nexus'` 是“经由 Nexus”的标记，`supervisorId` 是主管会话身份，`callId` 是发出该派活的工具调用；字段随原生 `user/message` 与 `agent/inbox/spliced` 完整落盘，可直接阅读。正文就是工具参数 `text`，不加转述前缀。投递路径不变：运行中走原生 `steer`，闲置走 `followup`。
- **识别：** `isNexusDispatch` 同时识别新形态（`kind: 'user'` 且 `via: 'nexus'`）与票 13 以前落盘的 `kind: 'nexus-dispatch'`；旧来源的类型声明保留，用于读取旧日志。结果回流（`src/results.ts`）只把对话会话中“`kind: 'user'` 且不带 Nexus 标记”的输入当作用户直接引导同步给主管；工作会话的轮次终态照常作为 `nexus-work-result` 回流，与派活来源无关。旧派活原本就不是 `user` 来源，从未被同步，本票只是把新形态一并排除。
- **主管识别自己的派活：** 主管系统指令（`src/realtime.ts`）补一句：工作会话记录中来源带 `via nexus` 的用户消息、以及较旧的 `nexus-dispatch`，是主管自己的派活，不是用户的直接输入（`nexus_read_session` 返回的记录含来源字段）。
- **新建会话命名：** Nexus 不起标题、不调用重命名。派活成为 `user` 来源后，原生 `dsh-session-title` 按普通会话处理：会话在派活前无标题（界面“未命名”）；派活被领取为 `user/message` 后，原生先写取开头几个词的兜底标题（`source: fallback`），再在该会话的首个主请求之后用该请求的模型路由生成标题（`source: provider`，首条提示词命名器 `session-title-first-prompt-llm`）。
- **已有会话：** 原生首条提示词命名只在“非子会话、该会话第一条 user 输入、尚无标题”时触发，兜底标题只在无标题时写入，所以已有标题的会话被派活不改标题；Nexus 不补旧的未命名会话。按原生规则推断（未专门测试）：只有旧派活、尚未命名的会话以后若再收到新形态派活，这条派活是它的第一条 `user` 输入，原生会像普通会话一样为它命名；本票把“不补”理解为不回填，不阻止这种原生命名，待裁定。
- **主会话名：** 主管会话进入原生会话表后（`src/index.ts`），若当前无标题，或最新标题来源不是 `user`（原生兜底 `fallback` 或模型生成 `provider`），调用原生 `sessionTitle.rename(session, 'Nexus')`；只有来源为 `user` 的标题保留（首轮评审后按协调者裁定从“只改兜底”放宽，见“检查与证据”中的首轮评审处置）。原生重命名记为 `source: user`，这也是原生唯一能在无 user 消息时写入的标题形态，并会锁定标题，此后主会话中的用户输入不再派生兜底标题。用户在 Desktop 改名同样经 `sessionTitle.rename` 记为 `source: user`，重启时不被覆盖；Nexus 自己写的 Nexus 与用户手动改名在记录上无法区分，两者都受保护。若用户对主会话执行原生标题刷新（解除锁定），原生在已登记命名器且主会话有 `user` 输入时走模型命名，写 `provider` 标题，否则写 `fallback` 标题（`dsh-session-title` `refresh`）；两种结果在下次启动时都改回 Nexus。为此插件新增注入 `sessionTitle` 与 peer 依赖 `@deepseek-ai/dsh-session-title@0.2.0-rc.2`（Desktop 的 `dsh-base` 已装载该服务）。
- **ADR 0004 的后果：** 原生按 `user` 来源统计或处理的行为现在也计入派活，例如会话列表的最近输入时间 `lastPromptAt`（证据中 Nexus 新建会话有值，只有旧派活的 `legacy-worker` 为 null）、`api-session/activity`、派活正文中的 `@会话` 引用解析、goal 工具的“本轮有用户输入”判断。浏览器时区上下文只读取带 `rpcId` 的消息，不受影响。

最高验证边界：隔离的官方 `dsh --profile nexus-titles --port 0 --no-open` 加载实际插件，经仓库 `tests/host-process.mjs` 的 `startHost`（Windows Job Object 整树清理）四次启动同一 `DSH_HOME`，原生会话落盘与原生 `dsh-session-title`（`dsh-base` 配置：兜底 5 词 / 40 字节、首条提示词命名器），第五次启动不加探针，用真实 headless Edge 打开官方 Web 客户端（与 Desktop 同一套客户端代码）。Realtime 主管为本地受控 WebSocket（fixture 凭据），按脚本发出派活工具调用；工作会话模型与命名模型是测试插件登记的受控原生适配器 `title-worker`（命名请求按原生 `purpose: 'session-title'` 返回 `Title <首条消息前 24 字>`）。未调用真实 DashScope、DeepSeek 或真实命名模型。受控端点通过不等于 Desktop 实机侧栏与真实命名模型。

证据在忽略目录 `.scratch/nexus-v1/`：`titles-*` 目录含 `phase-1/2/3/4.json`（每次启动的主管落盘事件、各工作会话事件、会话列表投影、工作模型实际收到的用户文本）、`result.json`（加脚本发出的工具调用与界面无障碍快照）、`ui-created.png`、`ui-legacy.png` 与原生 sessions；`ticket13/` 下是各次命令输出。

## 逐项验证

| 验收条目 | 实际观察与断言 | 限制 |
| --- | --- | --- |
| 新建会话先“未命名”，随后原生自动命名；派活显示为用户输入 | `nexus_create_session` 新建的会话：派活 `user/message` 之前没有任何 `session/title`；之后依次为兜底 `run-titled-new: 实现登录页并写测`（`fallback`，40 字节截断）与 `Title run-titled-new: 实现登录页并写测`（`provider`，`session-title-first-prompt-llm`）；会话列表投影标题同后者。Web 客户端侧栏显示该标题；打开会话后派活正文以普通用户消息显示（文本 + 时间 + 复制），与用户亲自输入的消息形态相同，没有“收到执行请求”。对照：只有旧 `nexus-dispatch` 派活的 `legacy-worker` 在侧栏为“未命名”，会话内显示为折叠的“收到执行请求”。 | 命名模型为受控适配器；Desktop 程序中的侧栏未实机。 |
| 运行中与闲置的已有会话派活均成功，标题不变 | `titled-idle`（闲置）工具结果 `delivery: followup`，`titled-busy`（运行中，保持在第 1 步等待引导）`delivery: steer`，两者都执行了派活（最终回复 `Worker executed: <派活原文>`）；两者 `session/title` 始终是派活前的兜底 + 模型标题两条，四次启动后不变。第二次启动后向已命名的新建会话再派活，标题同样不变。 | — |
| 派活不回流为用户引导；用户亲自输入照常同步；新旧派活重启后不回流、不重复 | 四次带探针启动后主管落盘日志中，`nexus-user-input` 恰好对应工作会话里全部 4 条用户亲自输入（两个已有会话的初始输入、新建会话中第一次与第二次启动各一条），各一次；5 条派活（第一次启动 3 条、第二次 1 条新形态，加 1 条旧 `nexus-dispatch`）的消息 id 都不在其中；`nexus-work-result` 按会话与轮次无重复，旧派活会话的轮次结果照常回流。中继单元测试：新形态 steer / 排队与旧形态都不同步，同一会话用户输入照常同步，重建中继后重放与新到的两种派活都不同步。 | — |
| 主会话名为 Nexus；用户手动改名后重启不覆盖 | 首次创建即为 `Nexus`（`source: user`）；第一次运行末尾模拟旧 Desktop 日志，在主管日志追加兜底标题 `PHASE-ONE dispatch`，第二次启动改回 `Nexus`；第二次运行末尾追加模型标题 `Model named supervisor`（`source: provider`，如原生刷新所写），第三次启动改回 `Nexus`；第三次运行末尾经原生 `sessionController.rename` 改为 `我的管家`，第四次启动保持 `我的管家` 且启动时不追加任何事件；主管日志的标题序列为 Nexus → 兜底 → Nexus → 模型标题 → Nexus → 我的管家，其间主会话四次用户输入都没有派生兜底标题。Web 客户端侧栏显示 `我的管家`。 | 用户 Desktop 主会话现有标题未读取（遵约束），见下文复核 4。 |
| 工作 agent 收到的派活正文与 Nexus 发出的一致，无前缀 | 落盘 `user/message` 正文与工具参数 `text` 逐字相等；工作模型第一次请求中 `user` 来源的文本恰好是 `["run-titled-new: 实现登录页并写测试"]`；来源对象恰为 `{ kind: 'user', via: 'nexus', supervisorId: 'nexus-supervisor', callId: <该工具调用 id> }`。 | — |

## 已知事实复核

1. **原生命名只接受 `user` 来源，旧派活会话无标题：** 属实。`@deepseek-ai/dsh-session-title` 0.2.0-rc.2 的 `sessionTitleUserMessageOf` 只取 `source.kind === 'user'` 的 `user/message`，其不变量也要求自动标题引用的消息为 `user` 来源。修改前的受控证据 `dispatch-controlled-1791660528067` 中 Nexus 新建会话没有任何 `session/title`；本票界面对照中旧派活会话为“未命名”，正文显示为折叠的“收到执行请求”。补充：自动命名在首条 `user` 输入后、该会话的首个主请求开始时才启动，模型路由默认取该主请求的路由；兜底标题先于模型标题出现。
2. **来源可扩展，`user` 来源可带额外字段并完整落盘：** 属实。`MessageSourceMap` 可合并扩展，Host 自身的 `user-rpc` 为 `{ kind: 'user', rpcId, clientTimeZone? }`；本票字段经第三次启动的冷读（`sessionController.inspect` 读落盘日志）原样读回。Host 中对 `user` 来源的特殊处理（上传回执、时区、提示去重）都以 `rpcId` 存在为前提，派活不带 `rpcId`，不受影响。
3. **结果回流把所有 `user` 来源视为用户直接引导：** 属实（修改前 `isDirectUserInput` 只判断 `kind === 'user'`）。新单元测试在修改前失败：新形态的两条派活被同步（`2 !== 0`）。
4. **主会话当前标题是早期测试消息形成的兜底标题：** 未在用户 Desktop 上复核（不读取 `~/.dsh`）。代码层面成立：修改前 Nexus 不写标题，主会话的用户输入是 `user` 来源，原生会为其写兜底标题；手动改名记为 `user`，兜底记为 `fallback`，模型标题记为 `provider`，三者由 `session/title.data.source.kind` 区分。本票按协调者裁定：标题缺失或来源不是 `user` 时改名，来源 `user` 保留。

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

### 首轮评审处置（快照 `195444d...22a2659`）

| 意见 | 处置 | 依据与证据 |
| --- | --- | --- |
| 标准#1 Host 未用 `startHost` | fixed | `tests/titles.test.mjs` 的四次探针启动与界面启动都改用 `tests/host-process.mjs` 的 `startHost`，关闭时整树清理后才启动下一个；启动参数集中在一个 `launch` 中（顺带处理标准#3）。 |
| 标准#2 测试中派活判定内联重复 | 不处理 | 协调者裁定。 |
| 规格(3) 主会话只保护 user 来源 | fixed | `src/index.ts` 改为标题来源不是 `user` 时（含无标题、`fallback`、`provider`）都改为 Nexus。测试增加 `provider` 情形：第二次运行末尾追加模型标题，第三次启动改回 Nexus。红测试 `ticket13/r2-red-titles.txt`：在旧条件（只改兜底）的构建上失败，第三次启动标题仍为 `Model named supervisor` / `provider`（证据 `titles-1791663703618`）；恢复新条件后 `ticket13/r2-green-titles-1.txt`、`-2.txt` 均 1 passed（证据 `titles-1791663743095`、`titles-1791663777417`）。 |
| 规格(2) 刷新描述不准 | fixed | 按 `dsh-session-title` `refresh`（lib/index.js 319–349）重写：已登记命名器且有 `user` 输入时写 `provider`，否则 `fallback`；按新规则两者重启后都改回 Nexus。 |
| 规格 medium 必需注入 `sessionTitle` | 已验证 | 先核对 `tests/desktop.test.mjs`：`npm pack` 输出到 `.scratch/nexus-v1/desktop-smoke-*`，Desktop 自带 `dsh.cmd plugin --profile nexus-desktop-smoke add` 与 Host 启动都使用该目录下的 `DSH_HOME`、`DSH_AGENTS_HOME`，不触碰 `~/.dsh` 与现用 Desktop 配置；本仓库无 `prepack` 脚本。运行 `NEXUS_DESKTOP_SMOKE=1 node --test tests/desktop.test.mjs`（`ticket13/r2-desktop-smoke.txt`）：1 passed / 0 failed / 0 skipped，证据 `desktop-smoke-XJqn3m`。加载模块来自隔离 profile 中安装的 tgz，安装仅 +2 个包，两次启动主管日志都只有 seq 1 的 `Nexus`（`source: user`）标题，重启没有重复改名。即 Desktop 自带运行时（`dsh-base`）提供 `sessionTitle`，Nexus 正常加载。 |
| 规格(1) 旧未命名会话再派活被原生命名 | 接受，无改动 | 协调者裁定符合 ADR 0004；上文如实标注。 |
| 规格 low 首次全量 Host 无输出退出 | 未再现 | 改用 `startHost` 后本轮全量未再现；未额外深挖。 |

本轮检查：`ticket13/r2-typecheck.txt`、`ticket13/r2-build.txt` exit 0；`node --test tests/results.test.mjs`（`ticket13/r2-results.txt`）13 passed / 0 failed；`titles` 单文件见上表；`git diff --check` 无输出。本轮全量 `ticket13/r2-npm-test.txt`：92 项，81 passed / 0 failed / 11 skipped，365.9 s，exit 0（本票证据 `titles-1791663870114`）；11 项 skipped 同前。


```powershell
npm run typecheck
npm run build
node --test tests/results.test.mjs
node --test tests/titles.test.mjs
npm test
git diff --check
```

## 用户实机验收发现与第 2 轮修复

2026-10-10 用户在 Desktop 安装 `2247020` 构建的 tgz 实机验收，发现两处问题。只读诊断使用用户导出的会话副本 `.scratch/nexus-v1/acceptance-20261010/`（sessions、storages、cordis.yml、cordis.patch.yml），未读写 `~/.dsh`；解码与导出脚本及结果在 `.scratch/nexus-v1/acceptance-20261010-diag/`（`decode.cjs`、`dump.cjs`、`titles.cjs`，工作会话全部事件 `s10dec.txt`，主管日志 `sup.txt`、`sup-window.txt`）。

**A. Nexus 新建会话只有兜底标题，没有模型标题（非 Nexus 缺陷，不改代码）。** 工作会话 `session-10dec8d3`：seq 9 派活来源为 `user` + `via: nexus`；seq 12 主请求路由 `ark-coding-plan/glm-5.3-flash`（Desktop `agent-default-model`）；seq 14 兜底标题“列出 src 目录下的文件。只输”；seq 15 原生 `session/title-llm-request`（`session-title-first-prompt-llm`，同一路由，`maxTokens: 64`），此后没有 `provider` 标题。即 Nexus 侧行为正确：派活取得命名资格，原生照常写兜底并发出命名请求。对照：用户自建会话 `session-d1f309d6` 路由 `deepseek-account/deepseek-flash`，seq 15 兜底、seq 16 请求、seq 19 得到模型标题；`session-8439fb02`（`deepseek-official/deepseek-v4-pro`）seq 18 同样成功。glm-5.3-flash 每次回答都先输出 reasoning（seq 16 简单一步也先推理，seq 37 输出 3459 tokens），`dsh-base` 默认的 `maxOutputTokens: 64`（未覆盖命名模型，沿用主请求路由）很可能被推理耗尽；原生 `dsh-session-title-llm` 此时抛出“reached maxOutputTokens”或“produced no text”，只记 `logger.warn`、不写会话，于是只剩兜底标题。按原生规则，同一路由下的普通会话也会如此；副本中没有用户手打首条消息且走 glm 的普通会话可直接对照，warn 原文在 Desktop 主机日志（`~/.dsh` 下）中，未读取。协调者裁定不改代码，向用户建议在 Desktop 配置中为 `session-title-llm` 指定不推理的命名模型。

**B. 用户在工作会话输入“发个你好，不要发其他的任何信息”，主会话立刻回了“你好”（Nexus 措辞缺陷，已修）。** 工作会话 seq 32/36（02:21:33.808）收到该输入，seq 37 回复“你好”，seq 39 轮次 completed（约 97 s，glm 推理用时）。主管日志 seq 561（02:21:33.810）收到 `nexus-user-input` 镜像，1 s 后 seq 563 主管自己回复“你好”，这就是用户看到的那句；seq 571（工作轮结束后 3 ms）收到 `nexus-work-result`（“Final content: 你好”），seq 573 主管确认。此前 seq 543 镜像“这句话照常同步到主会话”后，主管 seq 545 原样复述了这句话。三个轮次结果（工作会话 seq 23/31/39）各回流一次（主管 seq 533/552/571），两条镜像各一次（543/561），没有丢失或被去重吞没。根因是镜像通知（`src/results.ts` 末句“Treat it as the current user requirement … rather than only restating it”）与主管指令（`src/realtime.ts` 称其为“explicit user instructions … take priority”）都没说明它是写给工作会话 agent 的，镜像又按票 05 唤醒主管，实时模型便把内容当作对自己的命令执行或复述。

按协调者裁定采用方案 1，只改措辞，不改唤醒语义：
- 镜像通知末句改为两句：该输入写给那个工作会话的 agent，由它执行，执行结果会作为自动工作结果回来；主管不要自己执行或回答其内容，也不要复述。作为用户明确指令，它优先于主管此前的派活：只在它改变主管自己的安排时调整（例如停止或改派其他会话，或改变后续派活、评审与汇报），否则简短确认或保持安静。
- 主管指令（文字与语音共用部分）中关于 `nexus-user-input` 的一句同样改写，保留“优先于此前派活”的语义。
- `tests/results.test.mjs` 新增受控用例：以本次实机输入为内容，断言通知含上述关键语义且不再含旧句，并断言文字与语音两份主管指令含同样表述。

第 2 轮检查（未调用付费真实模型）：在旧措辞构建上运行新用例 `ticket13/r3-red-results.txt`：14 项，13 passed / 1 failed，失败的就是新用例（旧通知不含“addressed to the agent of that work session …”），exit 1；改后 `ticket13/r3-typecheck.txt`、`ticket13/r3-build.txt` exit 0，`ticket13/r3-results.txt` 14 passed / 0 failed，`ticket13/r3-steering.txt` 1 passed / 0 failed / 1 skipped（真实端点用例，证据 `steering-controlled-1791687448554`），全量 `ticket13/r3-npm-test.txt`：93 项，82 passed / 0 failed / 11 skipped，371.5 s，exit 0（比上轮多出本轮新用例 1 项；本票 Host 证据 `titles-1791687523105`；11 项 skipped 同前）；`git diff --check` 无输出。受控验证只锁定文本；真实实时模型是否据此不再代为执行，待用户在 Desktop 复验。

## 第 3 轮修复：文字镜像通知要求简短确认

2026-10-10，依据票 13 交接继续处理两轴评审共同指出的 medium，实施基点为 `8a635af`。第 2 轮措辞在文字与语音共用的 `TAIL` 以及镜像通知中允许 `stay silent`，而文字连接的空回复会被视为 `EMPTY_RESPONSE` 并成为错误轮次（`src/realtime.ts` 文字指令上方注释及 `docs/verification/04-global-result-delivery.md` 首轮评审处置第 4 项）。

- `src/realtime.ts` 共用指令与 `src/results.ts` 镜像通知均只保留 `otherwise acknowledge briefly.`。文字模式继续要求文字回复；语音模式保留 `VOICE_INSTRUCTIONS` 原有的 `you may say nothing when the user need not hear about it yet`。
- 保留输入由工作 agent 执行、用户明确指令优先于此前派活、主管只调整受影响安排的语义，以及票 05 的忙闲唤醒与处理方式。没有修改票 12 的压缩代码、设置或 Desktop 配置。
- `tests/results.test.mjs` 更新现有通知用例，断言通知不含 `stay silent`、两种主管指令共用段只要求简短确认；新增文字与语音模式回归，断言文字不允许 `stay silent` 或 `you may say nothing`，语音保留原有不出声许可。README 同一句改为说明语音模式下可以不出声。
- 规格轴 low 关于用户点名 Nexus 时“不要自己执行”的绝对措辞只作核实：后续句仍允许调整自己的安排，包括后续派活、评审与汇报；本轮按交接裁定不扩大修法。真实模型面对“让 Nexus 再开一个会话”等输入的行为仍待用户复验。

日志保存在忽略目录 `.scratch/nexus-v1/ticket13-handoff-20261010/`。在未修改产品代码的构建上，`red-build.txt` exit 0；`red-results.txt`：15 项，13 passed / 2 failed / 0 skipped，exit 1，失败分别是镜像通知仍允许 `stay silent`、文字指令仍允许 `stay silent`。改后 `typecheck.txt`、`build.txt` 均 exit 0；`results.txt`：15 passed / 0 failed / 0 skipped，exit 0。全量 `npm-test.txt`：96 项，85 passed / 0 failed / 11 skipped，368.3 s，exit 0（比交接基线多出本轮模式回归 1 项）；11 项 skipped 是需要真实端点或显式启用 Desktop 的既有用例，没有计作通过。`git diff --check` exit 0，没有空白错误，仅 Git 的 LF 到 CRLF 提示。

实施代理阶段没有打包、安装或调用真实模型，受控验证锁定的是通知与模式指令文本；完成后交由协调者评审并打包安装，过程如下。真实主管是否在文字模式下不再代为执行、复述或因保持安静产生 `EMPTY_RESPONSE`，仍待用户在 Desktop 复验。

### 第 3 轮双轴评审与安装

实施提交为 `1bfaabde4e6a73e76db98ba0d609d9572ee640bb`，本轮首轮双轴评审使用固定快照 `8a635afdeead48f801892e5d8b6dc3f0f6480644...1bfaabde4e6a73e76db98ba0d609d9572ee640bb`。标准轴 `approve`、问题列表为空；规格轴 `approve`、新增问题 0。交接遗留的文字静默许可 medium 已 fixed；点名 Nexus 的 low 维持待实机观察，不阻断本轮。本会话评审后没有代码修复（0 轮）；“第 3 轮”指交接中的票 13 修复轮次。

以下由协调者在评审通过后执行，实施代理核对已保存日志与验证报告后记入文档，没有重跑这些命令或套件。命令日志同在 `.scratch/nexus-v1/ticket13-handoff-20261010/`：

| 检查 | 结果与证据 |
| --- | --- |
| `npm ci --ignore-scripts` | exit 0，`pack-npm-ci.txt`。 |
| `npm run build` | exit 0，`pack-build.txt`。 |
| `npm pack --json --pack-destination .scratch/nexus-v1/ticket13-handoff-20261010` | exit 0，`pack.json`；产物 `E:\Agent\dsh-nexus\.scratch\nexus-v1\ticket13-handoff-20261010\dsh-nexus-0.2.0.tgz`，shasum `0e91e9bfdf8ef7857e1d50093e448756fad6d1e8`。 |
| `NEXUS_DESKTOP_SMOKE=1 node --test tests/desktop.test.mjs` | 1 passed / 0 failed / 0 skipped，16.605 s，exit 0，`desktop-smoke.txt`；隔离证据 `.scratch/nexus-v1/desktop-smoke-ikpIeY`，使用 fixture 凭据与本地受控 WebSocket，没有调用真实模型。 |
| Desktop 官方 CLI 安装上述 tgz | `D:\DeepSeekHarness\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add <上述 tgz 绝对路径>` exit 0，`desktop-install.txt`。 |
| 安装后哈希核对 | `install-verification.json`：`dist/index.js`、`realtime.js`、`results.js`、`compaction.js`、`supervisor.js` 及 `client.js` 均与当前构建一致；`dist/index.js` SHA256 为 `3D1B229113ADB9608463505B4C03D8A7D9BFD19EF147028D58C9911F3BA85F4D`。 |

用户明确回复“已退出”后，协调者在安装前两次检查 Desktop 进程均为空；仅复制备份 `sessions`、`storages` 和 desktop 顶层配置文件到 `C:\Users\25330\.dsh-backup-20261010-ticket13-bf79aa29`。`backup-verification.json` 确认数据文件数、字节数与配置文件哈希一致，未读取配置内容。没有启动用户 Desktop，以免自动语音触发真实模型调用；新包已安装，用户实机复验尚未完成，没有推送或创建 PR。

## 新包用户复验反馈（2026-10-10）

用户最初报告，除票 13 的语音直接输入、已有会话派活与引导两项外，已完成的验收步骤通过；随后更正“新建会话执行后没有标题”，并进一步确认具体是“只有派活开头几个字，没有模型生成的标题”。以澄清后的反馈为准：

| 项目 | 用户观察与当前状态 |
| --- | --- |
| 新建与派活显示 | 已通过：会话实际创建、派活按用户消息显示、正文无额外转述前缀。 |
| 新建会话命名 | 部分生效：用户确认已有派活开头几个字组成的原生兜底标题，但没有模型生成的标题。现象与此前 glm-5.3-flash 的已知限制一致；本次实际模型路由、原生命名请求与失败原因尚未核对，不能只凭标题形态确定同一根因。 |
| 文字模式直接输入 | 已通过：用户在工作会话亲自输入后，主管不代为执行或复述，没有 `EMPTY_RESPONSE`。 |
| 语音模式直接输入 | 验收被阻断：从 Nexus 切换至 dsh-nexus 下工作会话后语音断开，未完成保持通话时的镜像输入验证。此前让用户在同一界面切换会话的验收步骤需要修正；尚未确认切换是否卸载语音页面及其生命周期是否符合产品要求。 |
| 已有会话派活与运行中引导 | 未通过：用户报告任务引导未生效，认为可能是模型问题；这是用户判断，尚未核对主管工具调用、工作会话投递、下一步领取和实际行为，不能据此确定原因。闲置与运行中两种场景没有分别确认通过。 |
| 主会话名称、手动改名与重启保留 | 已通过。 |

本次只登记用户反馈，没有读取用户现用配置、调用真实模型、重新安装或修改产品代码。标题、语音切换及引导问题保留待核实，两票均不记整票验收完成。

## 本轮修复前未验证项（历史状态）

- 文字模式镜像输入已获用户确认通过；语音模式镜像输入被切换后的断话阻断，尚未完成验收。用户点名 Nexus 做事的补充步骤没有单独的会话证据。
- 新建会话已确认生成兜底标题；没有模型标题的实际路由、原生命名请求与失败原因待核对。
- 已有会话任务引导未生效的原因待核对，不预先归因于模型。
- 实机发现 A：Desktop 默认模型 glm-5.3-flash 下 Nexus 新建会话只有兜底标题（见上节，证据工作会话 `session-10dec8d3` seq 14/15，对照 `session-d1f309d6` seq 19）；同一模型下普通会话是否同样只有兜底、Desktop 日志中的失败原文，未验证；为 `session-title-llm` 指定不推理命名模型后的效果待用户确认。

- 主会话名称与改名重启保留、派活在会话中的显示已获用户确认；新建会话原生兜底命名已生效，模型标题尚未生成。原生命名的请求、结果与本次实际路由待核对。
- 用户 Desktop 主会话当前标题的实际来源（复核 4）。
- Desktop 打包冒烟（复审时授权运行，见上文首轮评审处置）只验证到插件在 Desktop 自带运行时加载、主会话标题落盘为 Nexus；冒烟截图时主会话尚无完成轮次，侧栏 Nexus 工作区下还没有列出它，会话标题栏显示的是会话 id `nexus-supervisor`。官方 Web 客户端对有完成轮次的主会话，标题栏与侧栏都显示标题（受控验证中为“我的管家”）。Desktop 中空白主会话是否显示 Nexus，待实机确认。
- 真实模型下主管是否据来源标记正确辨认自己的派活（读取会话记录时），未用真实模型验证。

## 第 4 轮：模型标题、跨会话通话与已有会话引导

2026-10-10，固定实施基点 `7e97bbc6bbba38c2ba43ffee2f836c5199ef0253`。用户不继续人工验收，并明确前两条注释（切换工作会话断话、已有会话任务引导）与模型标题都要修复。本轮三项同时实施；这取代前文 A 的“不改插件”处置，但不变更 ADR 0004 的来源、正文、原生命名与工作标题不由主管重命名规则。不改票 12 压缩实现，不修改 Desktop 配置或默认工作模型，不读真实凭据，不调用付费模型。最新用户会话仅由协调者复制 sessions 到忽略目录作只读诊断；没有写生产数据。

### 诊断与最小修复

| 问题 | 证据与修复 | 验证边界 |
| --- | --- | --- |
| 模型标题缺失 | 当前副本 `session-3bd49f9f` seq 14 是兜底“列出 src 目录的文件，不要修”，seq 15 原生命名走 `ark-coding-plan/glm-5.3-flash`、预算 64，之后无 provider 标题。真实失败 warn 未取到，不能把“推理耗预算”当作已证实的真实模型根因。真实原生命名服务加受控推理适配器重现了 64 只 reasoning、max-tokens、保留 fallback；同一路由仅预算改为 4096 后产生 provider 标题。新模块通过公共 `llm/stream` waterfall，仅标记本进程 `nexus_create_session` 创建的确切 live Session 与派活 callId，匹配第一条经 Nexus 的 user 输入、原生 first-prompt 命名器及稳定消息 ID/序号，消费一次资格，再把有限输出预算提高到至少 4096。原生标题提示仍要求短标题，失败仍留 fallback。 | 不改变路由、不增加思考策略/设置、不由 Nexus 生成标题；8192 等更大预算不降低；普通/旧/已有标题、用户先输入的新会话、手动刷新和正常工作请求不改。真实模型在此预算下的成功率未调用验证。 |
| 切换断话 | 浏览器通过原生侧栏切到工作会话，旧实现立即移除通话控件，麦克风 track ended。原因是 `CallBar` 的 sessionId 变化与组件卸载 effect 调用 hangup。保留客户端单一 Call owner 和插件释放 effect；输入 dock 仅显示闲置接通，活动/失败控件移至公共 `shell.overlay`。切换会话/项目、空白会话、设置不结束通话，侧栏折叠仍可见挂断。 | 真实 headless Edge、官方客户端、实际假设备麦克风采集与本地 WS；同一条模型连接保持，直接输入镜像进入该连接。设置原生模态打开时可先关闭设置再挂断，未覆盖其焦点规则。真实物理麦克风/扬声器与用户 Desktop 本轮未操作。 |
| 已有会话引导 | 真实主管 seq 1334 未先查列表而派错目标，用户纠正后 seq 1349 list、1355 正确 followup accepted。工作会话 `session-d1f309d6` seq 147 原生 pwsh 开 120 秒背景 job `pwsh-3`，seq 153 轮次已 completed；主管 seq 1379/1394/1400 只发 stop_session，agent 已闲置但 job 继续，最终 seq 161 输出 TIMER-2MIN-DONE。主管把 agent stop 接受误报为计时器停止；未发现原生 steer 传输丢失。工具说明与主管共用指令明确点名已有会话先查最新 projections.values.title/id；业务停止经 send_session 要求 worker 取消相关 job 并核实；stop_session 只取消当前轮次，返回 scope=current-turn、backgroundJobsCancelled=false、completed=false；只有实际工作结果/会话证据才可报停止完成。 | 不加 Host 意图分类或自动取消；闲置 followup、运行中 next-step steer 保持原生。受控主管执行既定工具脚本、受控 worker 执行真实原生 pwsh/job 工具，不宣称提示词可以保证真实模型遵循。 |

原生 `session/title-llm-request` 在 waterfall 前记录，仍包含 64 的原生参数提案；它不代表最终适配器收到了 64。实际调整通过插件 Host `logger.info` 的 `nexus title budget:` 记录（仅 sessionId、titleProvider、messageSeq、callId、originalMaxTokens、maxTokens），并由受控适配器真实 options 对照。没有额外自定义会话事件、没有重复原生请求事件、没有正文或凭据写入该审计日志。四次实际持久化重启仍只恢复原生已知事件。

### 本轮自验

命令日志位于 `.scratch/nexus-v1/ticket13-title-fix-20261010/`，不提交该目录：

- `red-repro.txt`：真实命名服务旧预算 64，适配器仅输出 reasoning 后 max-tokens，断言 provider 失败；`budget-experiment.txt` 仅把预算扩大后成功，`green-repro.txt` 为实际新模块成功。原始红实验保留，没有为了取红调用真实模型。
- `red-titles.txt`：实际隔离 Host 新建会话止于 fallback；`green-titles-final.txt`：1 passed / 0 failed，35.21 s。使用最终 logger 审计，实际发送命名预算 4096、同工作路由，普通命名仍 64；四次持久化重启与真实客户端检查通过，没有重复请求事件。中间 `green-titles.txt` 使用的重复请求审计方案已废弃，不作为最终证据。
- `title-budget.txt`：4 passed / 0 failed，178 ms；推理耗预算转成功、更高预算保留、旧/普通/已有标题和用户先输入不变、后续 refresh/工作请求不变、持续失败留真实 fallback。
- `red-voice-navigation-final.txt`：1 failed，7.654 s，切工作会话后控件 0、track ended；`green-voice-navigation-complete.txt`：1 passed / 0 failed，9.271 s，证据 `voice-navigation-1791700499187`。覆盖跨会话/项目、空白视图、设置、折叠侧栏、同通话输入镜像、显式挂断释放及返回 Nexus 不重开。
- `red-background-stop-final.txt`：1 failed，15.338 s，真实 job 在 agent stop 前后仍 running，返回缺少 current-turn scope；`green-background-stop.txt`：1 passed / 0 failed，14.986 s，证据 `steering-controlled-1791700605554`。worker 原生 pwsh → job_list → job_kill → job_output(wait) → job_list，全程无工具错误，最后 job killed。仅一次性 fixture 会话以公共 setSandboxMode 运行固定本地计时命令，绕过当前测试机器不可用的 Windows ACL sandbox；没有改变用户配置。
- 测试探索中背景第一次 timeout 是 fixture 未解包 Realtime function_call_output；另一 fixture 命令因 Windows ACL grantWrite 失败，未记为产品红。语音探索中的列表折叠、设置遮罩和“展开”按钮名称定位失败也未记为产品红，各证据目录保留。
- `typecheck-three.txt`、`build-three.txt` exit 0；`related-three.txt`：22 项，21 passed / 0 failed / 1 skipped（真实端点）；随后共享 steering Host 改用仓库 startHost 的 Windows Job Object 整树清理，最终完整套件另记结果。
- 首次全量 `npm-test-three.txt`：102 项，89 passed / 2 failed / 11 skipped，515.255 s，exit 1。两处旧测试用 `bar.evaluate(element)` 缓存活动控件，在挂断后仍点击已卸载的旧按钮，分别等待第二次 live 和前台工具期间重连超时；其他用例通过。将第二次点击重新查询当前 `[data-nexus-voice] button`，没有放松两次通话、精确状态序列、迟到麦克风释放、工具只执行/返回一次等原断言。`voice-races-current-control.txt`：1 passed，12.161 s；`voice-tool-current-control.txt`：1 passed，11.778 s。产品逻辑未因此修改，最终全量保留旧控件 isConnected 的诊断输出并重新验证。
- 第二次全量 `npm-test-three-final.txt`：102 项，90 passed / 1 failed / 11 skipped，394.522 s，exit 1；两项重新查询控件的通话回归均通过，诊断确认旧控件 `isConnected=false`。唯一失败在启动权限失败 fixture：等待已确认 ready.json 后再次读取，恰逢 probe 每 100 ms 截断重写文件的窗口，读取结果为空，获取 pid 抛 TypeError；尚未进入权限行为断言。改为保留等待时已成功解析的同一快照取 pid，没有忽略失败或增大超时。`startup-ready-snapshot.txt`：启动整文件 5 passed / 0 failed，73.548 s，覆盖重启、不重复自动接通，以及权限、设备、播放、模型失败后的手动恢复。产品文件未因该测试修正改变。
- 最终全量 `npm-test-three-final-2.txt`：102 项，91 passed / 0 failed / 11 skipped，399.079 s，exit 0；包括新增标题预算、跨视图通话、已有会话背景任务取消、原生闲置/运行引导，以及既有压缩、重启、断线、打断、工具与播放时序回归。11 项是需要真实模型端点或显式启用 Desktop 的既有用例，未计作通过。最终 `typecheck-final.txt`、`git diff --cached --check` 均 exit 0。没有因测试 fixture 修正再改产品逻辑。

实施阶段尚未打包安装；交回协调者按固定快照做标准/规格双轴评审，再打包与隔离 Desktop 冒烟。票 12 已有较长对话及后续操作仍未验收。用户不继续人工验收，不代表这些未执行步骤通过；真实模型遵循引导及本轮物理设备效果仍无新增实机结论。

### 第 4 轮双轴评审与安装

2026-10-11，实施提交 `434f75ee3f7141e2f26334c4e23d8d0dac3a102f`，双轴评审固定范围 `7e97bbc6bbba38c2ba43ffee2f836c5199ef0253...434f75ee3f7141e2f26334c4e23d8d0dac3a102f`。协调者报告标准轴与规格轴均 `approve`、`issues=[]`，评审后代码修复 0 轮。本轮用户明确的三项反馈在同一单元完成，没有扩展票 12。

以下由协调者在双轴通过后实际执行；实施代理只核对保存的日志与 JSON 后记入文档，没有重跑命令或测试。证据仍在 `.scratch/nexus-v1/ticket13-title-fix-20261010/`：

| 检查 | 结果与证据 |
| --- | --- |
| `npm ci --ignore-scripts`、`npm run build` | 均 exit 0，分别为 `pack-npm-ci.txt`、`pack-build.txt`。 |
| `npm pack --json` | exit 0，`pack.json`；26 个文件，产物 `E:\Agent\dsh-nexus\.scratch\nexus-v1\ticket13-title-fix-20261010\dsh-nexus-0.2.0.tgz`，shasum `bc63c018460601b58cb709305d6d604fcfa30f7a`。 |
| 隔离 Desktop 冒烟 | `desktop-smoke.txt`：1 passed / 0 failed / 0 skipped，16.116 s，exit 0；隔离证据 `.scratch/nexus-v1/desktop-smoke-GacpbM`。Desktop 自带运行时激活打包插件、查询原生项目与恢复会话记录，使用 fixture 凭据及受控本地端点，没有调用真实模型。 |
| 官方 CLI 安装 | `D:\DeepSeekHarness\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add <上述 tgz 绝对路径>`，exit 0，`desktop-install.txt`。安装器报告 peer 提示，核对结果见下文。 |
| 安装内容核对 | `install-verification.json`：referenceCommit 为上述实施提交，全部 26 个包文件的安装 SHA256 与构建匹配，包括新增 `dist/work-session-titles.js` 和 `client.js`；包 SHA1 与 pack shasum 一致。 |

用户此前明确回复“已退出”，协调者安装前两次确认没有 DeepSeek Harness 进程，没有再次启动用户 Desktop。只复制备份 `sessions`、`storages` 及 desktop 顶层文件到 `C:\Users\25330\.dsh-backup-20261011-annotations-bd6941cc`；`backup-verification.json` 确认 sessions 16 文件 / 2702671 字节、storages 16 文件 / 124904 字节在备份与来源间一致，顶层文件哈希匹配，没有查看配置内容。

`configuration-verification.json` 确认安装前后 `cordis.yml`、`cordis.patch.yml`、`pnpm-workspace.yaml` 不变；官方安装器更新了 `package.json` 和 `pnpm-lock.yaml` 的插件依赖元数据，因此不宣称所有顶层配置未变。未修改用户模型或业务配置、未读取真实凭据。

官方安装器的 peer 提示没有被忽略为“无警告”：协调者分别对当前 desktop profile 和安装同一包的隔离 Desktop profile 只读执行 `pnpm peers check`，`desktop-peers-check.txt`、`isolated-desktop-peers-check.txt` 均 exit 1，仅报告 peer 缺失。`peer-warning-verification.json` 确认两边各 21 个宿主 peer 名称完全相同，difference 为 0；同包隔离 Desktop 运行时实际加载已通过上述冒烟。保留该安装环境提示与验证边界，没有为消除提示自动修改 Host。

本轮包已安装，没有启动用户 Desktop、推送或创建 PR。票 12 长对话及后续操作仍未验，真实付费模型的命名成功率和引导遵循、物理音频设备均无新增实机验证；用户明确不继续人工验收，安装完成不记为这些步骤通过。

## 用户实机验收通过（2026-10-11）

用户补充反馈：“我测试了，确实是我麦克风没开。这三项全部都验收通过了。”确认的是安装第 4 轮修复后此前列出的三项：

| 验收项 | 本次结论 |
| --- | --- |
| 接通 Nexus 语音后切到工作会话和其他项目，通话保持，右下角仍能挂断 | 用户实机验收通过。 |
| 点名已有会话派活，再要求取消后台计时，目标正确且计时器实际停止 | 用户实机验收通过。 |
| Nexus 新建会话并执行任务后，标题成为模型生成的标题，而非派活开头几个字 | 用户实机验收通过。 |

此前“已接通但双方无声、识别不到语音”的反馈，经用户确认是麦克风未开启。该次诊断没有产品改动、提交、打包或重新安装；探索测试已归档至忽略目录 `.scratch/nexus-v1/voice-input-20261011/exploration-tests.patch` 后撤回，未把模拟采集挂起当作实际根因。

结合此前用户已确认通过的新建派活显示、文字输入镜像及主会话名称/手动改名重启保留，票 13 记为用户验收通过。此处证据来自用户反馈，协调者没有重跑真实模型或物理设备验收，也不外推为所有模型和设备下的成功率。票 12 的较长已有对话及后续操作仍未验收，本次反馈不改变票 12 状态。
