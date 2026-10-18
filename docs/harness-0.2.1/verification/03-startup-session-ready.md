# 03：启动自动接通等待会话列表就绪验证

实施基点：`9c8a87d`。实施与自验由本票实施代理完成，独立 code-review 由协调者安排。本记录不代表评审或用户实机验收通过。

## 实施范围

只改 `client.js` 中 `claimStartup()` 之后打开主会话的流程，不改 Host、协议、状态码与测试：

- 客户端插件的 `inject` 增加 `sessions`（`@deepseek-ai/dsh-api-session-controller` 的客户端 `ClientSessions`，`dsh-client-ui-workspace` 本身就依赖它，manifest 的 `client.inject` 无需改）。
- 新增 `supervisorListed(list, limit = 10000)`：`ctx.sessions.list.getSnapshot().ids` 已含 `nexus-supervisor` 时立即返回；否则订阅 `ctx.sessions.list`，列表出现主管或 10 秒到期时返回，并取消订阅、清掉定时器。
- `claimStartup()` 返回 true 后：`call.autoPending = true` → `await supervisorListed(ctx.sessions.list)` → 未卸载时才 `openSession(SUPERVISOR)`。之后的 `disposed` 检查与 `.catch(error => call.set('failed', error?.code ?? 'UNAVAILABLE'))` 不变。
- 超时不另设失败分支：到期后照常调用 `openSession`；主管仍不在列表时它照旧抛 `sessions.retain: unknown session`，由原有 catch 显示「通话失败 · UNAVAILABLE」。
- 自动接通只消费一次不变：Host 侧 `claimStartup` 的 `attempted` 没改，客户端等待期间不再请求认领，也不重试。

## 就绪信号及其来源

- `ClientSessions.list: SnapshotStore<SessionListState>`（`getSnapshot()` / `subscribe(listener)`），`SessionListState` 有 `ids`（Host 列表成员）与 `phase`（`'pending' | 'ready'`）。类型见 `node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/service.d.ts`（`readonly list`、`SessionListState.ids` / `phase`）与 `.../sessions/manager.d.ts:20`（`SessionListPhase`）；运行时由 `lib/client.js:3610` 的 `buildListSnapshot()` 投影，服务以 `reflect.provide("sessions", ...)` 暴露（`lib/client.js:3840`）。
- 原生 `dsh-client-ui-workspace` 恢复初始选中时用的就是同一个信号：`lib/client.js:1581-1597` 订阅 `this.sessions.list`，等 `phase === "ready"`。
- 等的是「`ids` 含主管」而不只是 `phase === 'ready'`：`resolveTarget`（`dsh-api-session-controller/lib/client.js:3007-3010`）要求主管在 `summaries` 里，`ids` 正是这份成员；在真实 Desktop 上窗口可能早于 Host 公告主管就拉到第一份列表，这时 `phase` 已是 `ready` 但主管要等后续 `session-added` 推送才进列表。

## 根因确认

在干净 worktree（`9c8a87d`）里临时插桩 `client.js`（认领为 true 时与每次列表变化时打印 `phase`、是否含主管、时间；catch 里打印错误），并让测试转发页面 `[diag]` 日志。插桩只在 worktree 中，已随 worktree 删除。原始日志：`.scratch/harness-0.2.1/03/diag-red-1.log`、`diag-red-2.log`。

未修复时（两次都一样）：

```
PAGE q07q [diag] claim true; phase=pending hasSupervisor=false ids=0 t=511.1
PAGE q07q [diag] startup failed: Error: sessions.retain: unknown session nexus-supervisor |     at SessionManager.resolveTarget ... |     at ClientSessions.retain ...
PAGE q07q [diag] list change; phase=ready hasSupervisor=true ids=1 t=532.8
...
PAGE ki2m [diag] claim true; phase=pending hasSupervisor=false ids=0 t=592.5
PAGE ki2m [diag] startup failed: Error: sessions.retain: unknown session nexus-supervisor ...
PAGE ki2m [diag] list change; phase=ready hasSupervisor=true ids=2 t=668.9
```

- 认领在页面第一次会话列表拉取落地前 20–80ms 就返回了；此时列表是 `pending`、空，`openSession` 同步抛错，被 catch 吞成 `UNAVAILABLE`。
- 不只是多窗口：第 2 次启动只开一个页面（`q07q`）时同样抛错。那次测试仍「通过」只是因为该页面的原生选中恢复正好落在主管上（此时只有主管一个会话），`autoPending` 加上主管可见触发了接通。第 3 次启动时已有第二个会话，新浏览器上下文没有保存的选中，原生恢复打开了别的会话，于是一个页面显示失败、另一个页面没有认领到，得到 `[0, 0]`。

修复后插桩（`diag-green-1.log`、`diag-green-2.log`）：

```
PAGE pxml [diag] claim true; phase=pending hasSupervisor=false t=510.1
PAGE pxml [diag] listed; phase=ready hasSupervisor=true t=530.4
PAGE bnak [diag] claim true; phase=pending hasSupervisor=false t=585.1
PAGE bnak [diag] listed; phase=ready hasSupervisor=true t=666.8
```

等待 20–80ms，在列表第一次带上主管时结束，用例通过。

上限验证（`diag-timeout.log`）：临时把等待条件改成永不满足的 id，第 3 次启动的认领页面在 `t=578.1` 认领、`t=10580.1` 等待到期后继续调用 `openSession`（这时主管已在列表，通话照常接通）。到期后主管仍不在列表的情形就是修复前的路径，`diag-red-*` 已证明它走原有失败态 `UNAVAILABLE`。

## 实际命令与结果

全部在 `E:/Agent/nexus-wt-03` 干净 worktree（`git worktree add E:/Agent/nexus-wt-03 9c8a87d`，`npm ci --ignore-scripts`、`npm run build`，再复制本票 `client.js`）中运行，避开仓库根目录未跟踪的 `promo/` 被 `dsh-workspace-changes` 整树快照拖慢（见票 01 验证记录）。跑完已删除 worktree。日志在 `.scratch/harness-0.2.1/03/`。

| 命令 | 实际结果 |
| --- | --- |
| 未修复：`node --test --test-concurrency=1 --test-name-pattern="native default and save" tests/startup.test.mjs`，3 次 | 3 次失败，均为 `concurrent clients share one automatic attempt on the new launch` 得 `[0, 0]`（`red-1.log`–`red-3.log`） |
| 未修复 + 插桩，2 次 | 2 次失败，根因见上（`diag-red-*.log`） |
| 修复 + 插桩，2 次 | 2/2 通过（`diag-green-*.log`） |
| 修复 + 永不满足的等待条件 + 测试里多等 12s | 10s 到期后继续打开主会话（`diag-timeout.log`） |
| 最终代码、去掉插桩，同一命令连续 3 次 | 3/3 通过，各约 35.7s（`green-consecutive-1.log`–`3.log`） |
| `node --test --test-concurrency=1 tests/startup.test.mjs` | 5/5 通过：native default…、permission、device、playback、model（`startup-file.log`） |
| `node --test --test-concurrency=1 tests/cascade-lifecycle.test.mjs`（同样使用 `autoVoice`） | 6/6 通过（`cascade-lifecycle.log`） |
| `npm run typecheck`（仓库目录与 worktree） | 通过，0 错误（`wt-typecheck.log`） |
| `npm test` 全套 | 146 项：129 通过、2 失败、15 跳过，23 分 0 秒，退出码 1（`wt-full.log`）。失败：R8（`ui`「Nexus footer opens an enabled native composer…」，`'请选择模型'` 不匹配 `qwen3.8-omni-flash-realtime`）；`profile`「official profile reports TIMEOUT without a completed turn or fake assistant」（见下）。startup 5 项全部通过 |
| `node --test --test-concurrency=1 tests/profile.test.mjs`，连续 3 次 | 3 次都是 13/13 通过（`profile-rerun-1.log`–`3.log`） |

关于 profile：之前记录的偶发项「official profile reports RESPONSE_FAILED…」本次全套通过（4.6s）。本次失败的是同组的 TIMEOUT 场景：10.7s 时断言 `profile did not produce a report`，输出只有 `dsh web: <url>`，即 Host 子进程在写出报告前就退出了（循环在 `child.exitCode !== null` 时提前结束，而不是等满 45s）。该组用例只起 Host 与探针，不开浏览器、不加载 `client.js`，与本票改动无关；单独重跑整个文件 3 次都通过。记为偶发，原因未查。

全部运行都使用隔离的 `DSH_HOME`，没有读写用户的 `~/.dsh`，也没有安装到用户的 `desktop` profile。

## 真实 Desktop 单窗口冷启动

可能触发。证据是每次未修复运行中，单页面的第 2 次启动也是认领先于列表第一次落地（约 510ms 对 530–550ms），这在新页面里是常态顺序，不是多窗口特有的。单窗口时能否「侥幸成功」取决于原生选中恢复是否正好落在主管：上次退出时停在主管（或只有主管一个会话）就能接通，停在其他会话或恢复成新建会话时就会显示「通话失败 · UNAVAILABLE」。Desktop 窗口若早于 Host 公告主管就连上，第一份列表里还可能没有主管，所以本票等的是列表含主管，而不只是 `phase === 'ready'`。未在真实 Desktop 上复现与验收。
