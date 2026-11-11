# Desktop 0.2.2-rc.1 适配验证

日期：2026-11-10。Nexus 从 0.2.3 更新为 0.3.0，目标是本机已升级的 DeepSeek Harness / Desktop 0.2.2-rc.1。

## 适配范围

- 开发 CLI 与所有直接引用的 `@deepseek-ai/dsh-*` SDK 精确固定为 `0.2.2-rc.1`，重新生成锁文件。锁文件中顶层 `@deepseek-ai/dsh-*` 包 320 个，全部为 0.2.2-rc.1；另有 57 条同名前缀条目是这些包内部嵌套的 `zod@4.4.3`，不是 SDK。
- 兼容区间收窄为 `>=0.2.2-rc.1 <0.3.0-0`，`engines.dsh` 与全部 dsh peer 同步。Cordis 从 4.0.5 升为 4.1.0，schemastery 从 3.18.5 升为 3.19.0。0.2.1 系列不再支持：其 SDK 的 `cordis-plugin-group` 要求 Cordis `~4.0.5`，与 4.1.0 冲突，且本版用到的 Host 接口在 0.2.1 上不存在。上一版 rc.5 的运行验证见[原验证记录](../../harness-0.2.1/verification/06-desktop-rc.5.md)。
- 新增直接引用 `@deepseek-ai/dsh-session-query`，peer 与开发依赖各一条。
- 本次有源码改动，原因是 0.2.2 的 Host 接口与 rc.5 不兼容：
  - `sessionController.inspect` 已移除，改用 `sessionQuery.observeSession(id, { signal, projectionMode: 'none' })` 返回的可释放观察租约；`nexus_read_session` 的分页读取从 `page` 改为 `events`。
  - `sessionProjections.stateOf(session, key)` 已弃用，收件箱改读 `snapshot(session, ['inbox']).values.inbox`；主管的 `Agent.model` 是新增必填成员，用 `register(modelSelectionProjectionDefinition)` 的 `readerFor(session)` 构造 `AgentModel`，与原生循环同一套注册单元。
  - 工具执行从单次 `execute({ callId, name, arguments, … })` 改为批量 `execute({ calls, signal, agent, log, maxParallelToolCalls })`，参数解析与 `tool/call`–`tool/result` 记录交给执行器；`maxParallelToolCalls: 1` 保留原有的一次一个调用。
  - `prepare()` 后的 Session 在 `enter()` + `announce()` 之前拒绝 append，announce 之后持久化后端会自动把事件路由到已打开的写句柄。开场 `model/selection` 与标题改名因此移到 announce 之后，只 `session.append`，由 `ctx.sessions.flush(session)` 做持久化屏障；再显式 `handle.append` 同一条事件会以 `append seq mismatch` 失败，并在下一次 flush 时把错误抛给正在执行的工具。恢复路径相反：`Session` 构造函数给种子追加的 `session/end-seed` 标记占一个 seq 却不发布，不会被自动路由，仍须在 `enter()` 之前把这段新后缀显式写入句柄。
  - 公布顺序改为与原生循环一致：`sessions.enter` 后立刻 `sessions.announce`，写完开场状态与 Workspace 成员关系，再把主管放进 agents 注册表。原先先注册主管、再 await 两次 Workspace 写入才 announce，这段窗口里 `agents.get('nexus-supervisor')` 已能取到主管，而它的 Session 还拒绝 append，此时进来的 prompt 被 Host 以 `session/agent-busy`「prompt rejected」退回。rc.5 的 `prepare()` 不挂存储，同一顺序没有可见后果。
  - `ctx.schedule.create` 改为 `(request, actorSessionId?, signal?)`，`timing` 与 `target` 显式成对；`list` 不再有 `sessionId` 过滤。归档探针按新签名调用。
  - `tests/probe.js` 的存储拒绝夹具改用分离的 `Session.create(id, undefined, header)` 构造待存工件：`prepare()` 出来的 Session 在 announce 前不能 append，夹具原本正是这样写入的。
- `tests/compatibility.test.mjs` 的原生兼容门接受版本改为 `0.2.2-rc.1`、`0.2.2`、`0.2.5`，拒绝版本加入 `0.2.1-rc.2`、`0.2.1-rc.5`、`0.2.1`。
- 压缩夹具按新 Host 的固定提示重新标定。0.2.2-rc.1 的主管固定请求比 rc.5 大 852 tokens（`compaction-auto` 首次压力 11671 对 10819，`call-discarded` 11783 对 10931），每条长提示的增量两边都是 1820。`call-discarded` 的长提示由 6 条改为 7 条：6 条时自动压缩选出的区间约 2031 tokens，不到请求 19063 tokens 的 25%，被跳过，场景里只剩手动 `/compact` 一条记录，断言拿不到带 turn 号的自动压缩。
- 更新中英文 README、安装指南与安装包版本。`cordis.patch.yml` 未改动，仍只含 `credentialRef: DASHSCOPE_API_KEY` 与官方 wss 端点。

## 环境

Windows。Desktop 自带 CLI 为 `D:/DeepSeekHarness/resources/runtime/cli/bin/dsh.cmd`，实际 `--version` 为 `0.2.2-rc.1`；`primary-runtime/runtime.json` 声明 `desktopVersion` 0.2.2-rc.1、Node.js 24.21.0、pnpm 11.28.5。Desktop 内置 `@deepseek-ai` 包 331 个，其中 321 个为 0.2.2-rc.1，cordis 4.1.0、schemastery 3.19.0。

全套测试在独立副本 `E:/Agent/nx-022rc1-20261110` 执行，使用独立 `DSH_HOME`、本地受控模型与语音端点，不复制日常会话或凭据。副本不含 `.git`、`promo` 等日常工作区内容。

测试运行时使用独立的 Node **24.22.1**（libuv 1.52.1），可执行文件为 `C:/Users/25330/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`。测试通过 `process.execPath` 启动 Host，因此整套 Host 与测试进程使用同一个 Node。系统 PATH 上的 `D:/Node.js/node.exe` 是 24.15.0（libuv 1.51.0），在 Windows 上有已确认的原生 TCP 连接崩溃（[nodejs/node#63620](https://github.com/nodejs/node/issues/63620)，修复见 [PR 62561](https://github.com/nodejs/node/pull/62561)），不作为验收运行时；诊断记录见本机 `.scratch/rc5-diagnosis/diagnosis.md`。

## 结果

| 检查 | 结果 |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | 通过，658 个包；锁文件 320 个顶层 dsh 包均为 0.2.2-rc.1 |
| `npm run typecheck`、`npm run build` | 通过（Node 24.22.1） |
| `node --test tests/compatibility.test.mjs` | 2/2 通过 |
| `node --test --test-concurrency=1 tests/*.test.mjs` | 148 项：133 通过、0 失败、15 跳过；22 分 28 秒 |
| Desktop CLI 打包安装、级联完整流程、干净 profile 场景 | 3/3 通过；43 秒 |

全套日志在测试副本的 `tests.log`，Desktop 冒烟日志在 `desktop.log`。全套的 15 项跳过是 3 个 Desktop 用例加 12 个需要真实 DashScope 或真实 Realtime 模型的选用例。Desktop 用例默认按开关跳过，本次以 `NEXUS_DESKTOP_SMOKE=1` 单独执行，3 项全跑。

原生兼容门允许 `0.2.2-rc.1`、`0.2.2`、`0.2.5`，拒绝 `0.2.1-rc.2`、`0.2.1-rc.5`、`0.2.1`、`0.2.0-rc.2`、`0.3.0-rc.1`、`0.3.0`。这项检查验证版本声明，不代表已经对所有允许版本做过运行验收。

## 安装包与本机更新

- 包：`.scratch/harness-0.2.2-rc.1/delivery/dsh-nexus-0.3.0.tgz`，31 个文件，76585 字节。
- SHA256：`945015b0e4c40bb07158a4967fcc1cb230afdfa3c1f319074ea0622f50126544`。
- 本机更新前，旧版插件与 profile 安装配置已备份到 `.scratch/harness-0.2.2-rc.1/backup-before-0.3.0/`。
- 安装命令：`dsh plugin --profile desktop add <tgz> @deepseek-ai/dsh-hooks-claude-code@0.2.2-rc.1 @deepseek-ai/dsh-hook-protocol@0.2.2-rc.1`，用 Desktop 自带 CLI（`--version` 报 `0.2.2-rc.1`）执行，pnpm 5.2 秒完成：`dsh-nexus` 0.2.3 → 0.3.0，两个 hooks 包 0.2.1-rc.5 → 0.2.2-rc.1。安装前 Desktop 进程未在运行。
- hooks 两件套一起升，是因为 profile 里启用的 `shared-memory-guard` 用的就是 `@deepseek-ai/dsh-hooks-claude-code`，留在 0.2.1-rc.5 会把旧 Cordis/SDK 带进 0.2.2 的 Host。
- 逐文件核对：解包出的 31 个文件与 `profiles/desktop/node_modules/dsh-nexus` 逐个 SHA256 一致，无多余文件；profile 中其他插件依赖未变，`cordis.patch.yml` 与备份逐字节相同，`shared-memory-guard` 及其 `configPath` 保持原样。报告在 `.scratch/harness-0.2.2-rc.1/installed-verification.json`。
- `pnpm peers check` 报的 missing/conflicting peer 是 profile 的结构性现象，不是本次引入：profile 只装插件，Host SDK 由 Desktop 运行时提供，旧版 0.2.3 同样是 21 条区间 peer；conflicting 项是 hooks 的精确锁定 `0.2.2-rc.1` 与 Nexus 区间 `>=0.2.2-rc.1 <0.3.0-0` 的写法差异，同一个版本同时满足两者。实际激活由 Desktop 冒烟用例验证。
- 本次没有发布 GitHub Release。

自动检查使用假音频设备，不代替物理麦克风、真实 DashScope 和实际默认模型的连续验收。