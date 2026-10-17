# 01：版本区间、测试夹具与过时补丁验证

实施基点：`a9ecae5`。实施与自验由本票实施代理完成，独立 code-review 由协调者安排。本记录不代表评审或用户实机验收通过。

## 实施范围

- `package.json`：插件版本 0.2.1；`@deepseek-ai/dsh*` peer 全部改为 `>=0.2.1-rc.2 <0.3.0`，新增 `engines.dsh` 同一区间；`@deepseek-ai/cordis` `^4.0.5`、`@deepseek-ai/schemastery` `^3.18.5`；devDependencies 精确写 `@deepseek-ai/dsh` 0.2.1-rc.2、`@deepseek-ai/cordis` 4.0.5、`@deepseek-ai/schemastery` 3.18.5。`npm install` 重新生成 `package-lock.json`，锁文件中已没有 0.2.0-rc.2 包。
- R7：删除 `src/work-session-titles.ts`、`src/work-sessions.ts` 中的导入、注册与 `trackTitle` 调用、`tests/title-budget.test.mjs`；同时删除只为该文件加入的 peer `@deepseek-ai/dsh-session-title-llm`（源自 `434f75e`，删除后 `src/` 再无引用）。`titles.test.mjs` 删去两条只验证补丁的断言（补丁日志 `nexus title budget`、「普通会话仍为 64」），`titles-probe.js` 删去对应的日志收集；新建会话标题请求为 4096、原生请求不重复、模型标题生成等其余断言保留，现由原生 4096 满足。
- R1a：新增 `tests/native-settings.mjs` 的 `openSettings(page, options)`（账号菜单 → menuitem「设置」），替换 7 个文件里原来的侧栏「设置」按钮点击。
- R1b（裁定 9）：14 个使用浏览器的测试在测试 profile 的 `cordis.patch.yml` 里加入 `ui-settings-models` / `@deepseek-ai/dsh-client-ui-settings-models` 的 `credentialOnboarding: false`。已有 `welcomeNoticeVersion` 的 11 个文件追加在其后；`clean-install`、`titles`、`ui` 原本靠点击「继续」处理预览版说明，保持不变，未新增 `welcomeNoticeVersion`。没有使用 `page.addLocatorHandler`。`ui.test.mjs` 删掉对已不存在的「稍后配置」的硬点击；其余文件里带 `isVisible()` 守卫的「稍后配置」清理循环未改（现在是空操作）。
- R2：`dispatch-probe.js`、`delivery-probe.js` 改用 `startActivation({ ..., delivery: 'parent' })`，对返回的 `result` 加 `.catch(() => {})`；`drainContinuableChildren` → `drainChildren`。
- R3：`steering-probe.js` 作业 id 正则 `/pwsh-\d+/` → `/pwsh-[0-9a-f]+/`。
- R4（裁定 3）：`compaction.test.mjs` 的 useless 场景预算 9000 → 10850，长历史 `{ long: 4 }` → `{ long: 6 }`，末尾断言 `LONG-4` → `LONG-6`，两处 `> 9000` 同步为 `> 10850`。
- R5（裁定 4）：`restore.test.mjs` 的 active-exit 期望改为 `{ kind: 'aborted', reason: { kind: 'disposed' } }`；interrupt 场景的 `interrupted` 期望不变。
- archive：测试 probe patch 去掉重复的 `@deepseek-ai/dsh-schedule`（`dsh-web-app` 已自带），schedule 相关断言不变并通过。
- 文档：README（中英）徽章、环境要求、tgz 文件名、`--version` 示例；`docs/installation-and-use.md` 的版本说明、tgz 文件名、旧包替换说明。
- 未改 `src/voice.ts`、`client.js`、`cordis.patch.yml`、协议与状态码。

## 每处测试改动与根因

| 根因 | 文件 | 改动 |
| --- | --- | --- |
| R1a | cascade-spoken、cascade-tap、cascade、compaction、startup、ui-polish（2 处）、voice | 侧栏「设置」→ `openSettings` |
| R1b | cascade-barge、cascade-install、cascade-lifecycle、cascade-spoken、cascade-tap、cascade、clean-install、compaction、desktop、startup、titles、ui-polish、ui、voice | profile patch 关闭 `credentialOnboarding`；ui 去掉「稍后配置」硬点击 |
| R2 | dispatch-probe、delivery-probe | `startActivation` / `drainChildren` |
| R3 | steering-probe | 十六进制作业 id |
| R4 | compaction | 预算 10850、历史 6 段 |
| R5 | restore | `aborted(disposed)` |
| R7 | titles、titles-probe、title-budget（删除） | 删除补丁专属断言与测试 |
| 重复挂载 | archive | 去掉 `dsh-schedule` |

## 环境发现：仓库目录下的测试变慢

在本仓库目录直接跑时，`delivery.test.mjs`、`steering.test.mjs` 连续两次失败（「the result was admitted while a supervisor turn was open」「the older result also arrived during the busy turn」），且 `archive.test.mjs` 用时 32 秒；同样的代码在诊断副本中 7 秒，delivery 通过。排查结果：

- 两边锁文件版本一致；把本仓库的 `package.json`、`dist/work-sessions.js` 分别放进诊断副本后 delivery 仍通过，排除本票改动。
- Host 以仓库根目录为主管 cwd。0.2.1-rc.2 的 `@deepseek-ai/dsh-workspace-changes` 在每个轮次开始与结束时对 git 仓库做整树快照（私有 index 上 `git add --all`，包含未跟踪、未忽略的文件）。本仓库工作区有与本票无关的未跟踪 `promo/`（226 MB）与 `.claude/`（22 MB、1000 余个文件），每次快照都要重新哈希它们，主管轮次因此被拖慢，时序断言失败。诊断副本不是 git 仓库，没有快照。
- 按约束不能动 `promo/`、`.claude/`。于是在 scratch 中建了 `a9ecae5` 的干净 git worktree，应用本票全部改动，`npm ci --ignore-scripts` 后验证：delivery 1/1、steering 2/2 通过。下面的全套结果以该 worktree 为准，同时在仓库目录也跑了一遍全套作对照。

这是 Harness 原生行为与本机工作区内容的组合，不是 Nexus 回归，本票不处理；若用户在含大量未跟踪文件的 git 仓库里启动 Host，主管轮次同样会变慢，记为后续可关注项。

## 实际命令与结果

| 命令 | 实际结果 |
| --- | --- |
| `node <scratch>/compat.mjs E:/Agent/dsh-nexus`（调用 `dsh-app-boot` 的 `evaluatePluginCompatibility`） | 新 manifest 在运行时 0.2.1-rc.2、0.2.1、0.2.5 下返回 `undefined`；0.3.0、0.2.0-rc.2 下按 `engines.dsh` 拒绝；旧 0.2.0 manifest 在 0.2.1-rc.2 下被拒。见 `.scratch/harness-0.2.1/01/compat.txt` |
| `npm run typecheck` | 通过，0 错误 |
| `npm run build` | 通过；`dist/` 中残留的旧 `work-session-titles.*` 已手动删除（`tsc` 不清理产物，`files` 含 `dist`） |
| `node --check` 全部改动的测试文件与 `tests/native-settings.mjs` | 全部通过 |
| 仓库目录逐文件：archive / dispatch / restore / titles / ui-polish / compaction | 1/1、1/1（1 跳过）、5/5（1 跳过）、1/1、8/8、10/10 |
| 仓库目录逐文件：ui | 0/1，失败于 R8（`'请选择模型'` 不匹配 `qwen3.8-omni-flash-realtime`），符合预期 |
| 仓库目录逐文件：delivery、steering（各跑两次） | delivery 0/1、steering 1/2，原因见上节 |
| worktree：delivery、steering | 1/1、2/2 |
| worktree：`npm test` 全套 | 146 项：127 通过、4 失败、15 跳过，25 分 11 秒，退出码 1。失败：`cascade-tap` 挂断重拨（R6，`waitFor` 等不到「已接通」）、`startup` 新 Host 周期（R9，`concurrent clients share one automatic attempt on the new launch` 为 `[0, 0]`）、`ui` Realtime 模型名（R8）、`profile` 的 `official profile reports RESPONSE_FAILED without a completed turn or fake assistant`（Host 11 秒内提前退出，只输出了 URL 行）。日志 `.scratch/harness-0.2.1/01/wt-full.log` |
| worktree：`node --test tests/profile.test.mjs` 两次 | 两次均 13 通过 / 0 失败 / 1 跳过，全套中的那次 profile 失败未能复现 |
| worktree：`NEXUS_DESKTOP_SMOKE=1 node --test --test-concurrency=1 tests/desktop.test.mjs tests/cascade-install.test.mjs tests/clean-install.test.mjs` | 3/3 通过，52 秒。`D:/DeepSeekHarness` 自带 0.2.1-rc.2 CLI 以隔离 `DSH_HOME` 执行 `dsh plugin add dsh-nexus-0.2.1.tgz`，安装日志 `+ dsh-nexus 0.2.1`，未被兼容门拒绝。日志 `.scratch/harness-0.2.1/01/wt-smoke.log` |
| 仓库目录：`npm run build && npm test` 全套 | 146 项：118 通过、13 失败、15 跳过，45 分 20 秒，退出码 1。除 R6（cascade-tap 挂断重拨）、R8（ui）、R9（startup）外，另有 10 项时序失败：cascade-barge 3 项、cascade-spoken 2 项、delivery、steering、voice 3 项（navigation、hang-up、interleaving），断言均为「某事发生在某轮次之内 / 之前」或 15 秒等待超时；这些用例在 worktree 全套中全部通过，归因于上节的整树快照拖慢。日志 `.scratch/harness-0.2.1/01/repo-full.log` |

全部运行均使用隔离的 `DSH_HOME`，没有读写用户的 `~/.dsh`，也没有安装到用户的 `desktop` profile。

## 与诊断试验的差异

- 首启弹窗按裁定 9 用 profile patch 关闭，没有使用试验中的 `addLocatorHandler` 版 `firstRun`；14 个浏览器测试都按这个方式通过（R6/R8/R9 用例除外，它们失败在弹窗之后的断言上）。
- helper 名为 `tests/native-settings.mjs`，只保留 `openSettings`。
- 额外删除 `@deepseek-ai/dsh-session-title-llm` peer，并删除 `dist/` 中的旧补丁产物。
- devDependencies 按 Spec 增加 cordis 4.0.5、schemastery 3.18.5 两项（试验副本未加）。
