# 02：挂断后立即重拨不再误报占线验证

实施基点：`c565261`。实施与自验由本票实施代理完成，独立 code-review 由协调者安排。本记录不代表评审或用户实机验收通过。

## 实施范围

只改 `src/voice.ts`（`VoiceController`），不改协议、状态码、`client.js` 与测试：

- 新增私有 `release(owner)`：只有当前 `owner` 仍是这通电话自己的 symbol 时才清空，并唤醒正在等待的 `call()`；重复调用或旧通话收尾时新通话已占用，都不做任何事。
- 实时泵收到 `hangup` 上行时，在 `live.hangup(...)` 之后立即 `release(owner)`，不再只等生成器 `finally`；`finally` 里改为同一个 `release(owner)`（幂等）。
- `call()` 开头遇到占用时，最多等 500ms 让占用释放（`vacated` 等待集合 + `setTimeout`）；等待后若 signal 已中止则直接返回；仍被占用才回 `CALL_BUSY`。检查与占用之间没有 `await`，多个等待者同时被唤醒时只有第一个拿到占用，其余照常报 `CALL_BUSY`。
- 旧通话 `finally` 里的 `live?.end()` 在新通话占用之后执行也不会影响新通话：`supervisor.ts` 的级联 `end` 以 `this.cascadeCall === call`、Realtime `hangUp` 以 `this.call !== call` 守卫；两种模式的 `live.hangup` 都同步清掉主管里的 `call` / `cascadeCall`，所以新通话的 `startCall` 不会因旧通话再报 `CALL_BUSY`。

## 根因确认

在干净 worktree（`c565261`）中临时插桩 `dist/voice.js`（`call()` 进入、`CALL_BUSY`、泵读到 `hangup`、`finally`）与 `@deepseek-ai/dsh-api-gateway` 的 `RemoteStreamMuxConnection.receive`（线上帧到达），只跑该用例。插桩只在 worktree 中，已随 worktree 删除。原始输出：`.scratch/harness-0.2.1/02/diag-runs.txt`。

未修复时第二通电话挂断、第三通接通的片段：

```
6596.6 wire item 5bb6c4 {"type":"hangup",...}
6596.7 wire open fadca3 nexusVoice/call
6596.9 call#3 enter owner=true
6597.0 call#3 BUSY
6597.0 call#2 uplink hangup
6597.0 call#2 finally
```

- 客户端确实先发出了挂断：`hangup` 帧比新通话的 `open` 帧早 0.1ms 到达 Host，两帧几乎同时到达（测试第二次挂断后立即点「接通语音」，中间没有等待）。
- 两帧进入 gateway 后分别走独立的微任务链：`hangup` 经 `UplinkInbox` → 解码 → `voice.ts` 泵；`open` 经 `openWireStream` → `call()` 生成器首次 `next()`。新通话的占用检查先于旧泵读到挂断，于是 `CALL_BUSY`。协调者诊断中「busy 早于 hangup 上行」指的是泵读到挂断的时刻，不是线上到达时刻。

## 取舍：为何同时加了等待

先只做裁定 6 的第一步（泵收到 `hangup` 立即释放，不加等待），连续 13 次（3 + 10）运行该用例：10 次那一轮 5 通过 / 5 失败，失败的 5 次都是 `call#3 enter owner=true` 先于 `call#2 uplink hangup`。两条链的先后取决于微任务排队，只差约 0.1ms，传输层不保证顺序，所以第一步不足以消除竞争。

于是按裁定 6 的第二步加上最多 500ms 的等待。加上后连续 10 次全部通过，其中 3 次仍是新通话先进入（`owner=true`），等待在约 0.1–0.3ms 内被旧通话的释放唤醒，没有报 `CALL_BUSY`。第一步保留：它让释放不依赖 gateway 是否继续拉取旧生成器，等待通常只需微任务级时间。

真实占线（另一个客户端持有通话）时，第二个客户端会多等 500ms 才看到「另一个窗口正在通话」，这是裁定 6 允许的代价。

## 实际命令与结果

全部在 `E:/Agent/nexus-wt-02` 干净 worktree（`git worktree add E:/Agent/nexus-wt-02 c565261`，再复制本票 `src/voice.ts`，`npm ci --ignore-scripts`、`npm run build`）中运行，避开仓库根目录未跟踪的 `promo/` 被 `dsh-workspace-changes` 整树快照拖慢（见票 01 验证记录）。跑完已 `git worktree remove` 并删除目录。日志在 `.scratch/harness-0.2.1/02/`。

| 命令 | 实际结果 |
| --- | --- |
| 未修复：`node --test --test-concurrency=1 --test-name-pattern="hangup and client disconnect" tests/cascade-tap.test.mjs`，4 次 | 1 通过、3 失败；整文件 `node --test --test-concurrency=1 tests/cascade-tap.test.mjs` 5 通过 / 1 失败（该用例）。失败均为第三次 `connected(page)` 等不到「已接通」 |
| 未修复 + 插桩，2 次 | 2 次失败，都是 `CALL_BUSY` 先于旧泵读到 `hangup`（见上节） |
| 只做第一步 + 插桩，13 次 | 8 通过、5 失败 |
| 第一步 + 500ms 等待 + 插桩，10 次 | 10/10 通过 |
| 最终代码、去掉插桩并核对 gateway 与仓库 `node_modules` 逐字节一致后，同一命令连续 3 次 | 3/3 通过（8.3s 左右） |
| `node --test --test-concurrency=1 tests/cascade-lifecycle.test.mjs` | 6/6 通过，含「cascade sole media owner rejects another page before capture; close / disconnect …」两项：第二个页面仍显示「另一个窗口正在通话」、提示 `CALL_BUSY`、未采集麦克风 |
| `node --test --test-concurrency=1 --test-name-pattern="another client cannot acquire media" tests/voice.test.mjs` | 1/1 通过：Realtime 模式第二个客户端仍报 `CALL_BUSY`，不采集、不播放 |
| `npm run typecheck`（仓库目录与 worktree） | 通过，0 错误 |
| `npm test` 全套 | 146 项：129 通过、2 失败、15 跳过，22 分 48 秒，退出码 1。失败只剩 R9（`startup voice: native default and save, new Host cycles…`，断言 `concurrent clients share one automatic attempt on the new launch` 为 `[0, 0]`）与 R8（`ui`「Nexus footer opens an enabled native composer…」，`'请选择模型'` 不匹配 `qwen3.8-omni-flash-realtime`）。`cascade-tap` 该用例通过。日志 `wt-full.log` |

票 01 全套中偶发的 `profile`「official profile reports RESPONSE_FAILED without a completed turn or fake assistant」本次全套通过（4.7s），未复现。

全部运行均使用隔离的 `DSH_HOME`，没有读写用户的 `~/.dsh`，也没有安装到用户的 `desktop` profile。

## 真实占线测试覆盖

已有用例，本票未新增：

- `tests/cascade-lifecycle.test.mjs`「cascade sole media owner rejects another page before capture; ${ending} preserves Host text work and reentry」（`close`、`disconnect` 两项）。
- `tests/voice.test.mjs`「disconnect lifecycle: another client cannot acquire media, closing the owner keeps background text and manual reentry」。

挂断后立即重拨的回归由 `tests/cascade-tap.test.mjs`「hangup and client disconnect abort recognition…」覆盖：修复前在 0.2.1-rc.2 上基本稳定失败，修复后连续通过。
