# 本机 Desktop 打包冒烟与测试清理

验证日期：2026-10-09。unitBase：`f3a125f1672364a3666040f1d4e681fc4957bd0b`。官方 Desktop 自带 CLI：`D:/DeepSeekHarness/resources/runtime/cli/bin/dsh.cmd`，现有 Harness `0.2.0-rc.2`。未修改宿主、Qiyu 或用户 profile，未进行付费模型调用。

## 诊断更正与最终范围

最初冒烟预写了 profile 的 `package.json`，官方插件管理器因此把它视为已初始化，跳过 `initProfile` 的 `pnpm-workspace.yaml`。安装日志出现 84 个包，包含自动安装的 Host peer SDK。插件与 Host 分别加载错误类和 scope；模块私有 Symbol 不同，使首启的 `instanceof` 判定失败，后续原生输入也被 file-upload 拒绝为 `session/agent-busy`。

rc.2 的官方初始化会设置 `nodeLinker: hoisted`、`autoInstallPeers: false`。正确做法是让 `plugin add` 在真正空 profile 中完成初始化，再保留生成的设置，仅调整 bundle 为 base、web-app、Nexus。最终安装仅增加 Nexus 与 ws 两个包；pnpm 提示未满足 peer，但运行时由 Host 提供这些 peer SDK，实际 scope/激活/输入均通过。外部 node_modules 链接有不同的 peer 路由，因此此前简化诊断的成功也不能代表实际安装。

在相同正确 profile 下，保留旧 `instanceof` 的最初 tgz 和还原后的当前构建均通过原生输入、完成轮次与重启恢复。原先产品激活/scope 缺陷定性撤回，不保留错误字符串识别或包装绕过。最终产品源码和依赖清单没有变化；本单元增加可靠的官方打包冒烟、持久化错误传播覆盖，并修复测试进程清理。

相关公开契约见[官方插件发布说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。实际判断以本机 rc.2 `dsh-app-boot` 的 `initProfile` 和 profile resolver、`dsh-plugin-manager` 官方安装路径及以下差分实测为依据。

## 验证与证据

- 清理红测：`node --test tests/host-process.test.mjs`，仅杀根进程的旧行为留下子进程，正常关闭和 readiness 失败两个场景均失败；`.scratch/nexus-v1/activation-cleanup-red.txt`。
- 清理绿测：同命令，2 通过；`.scratch/nexus-v1/activation-cleanup-green.txt`。Windows 使用自己创建的 PID 的 `taskkill /T /F`；另一独立进程始终存活。Host 启动失败也在 finally 清理，语音测试为 Host、浏览器和受控模型服务器立即登记清理。
- 持久化错误：主管 journal 已被占用与有效压缩但损坏的原生 header，均保留原始错误，未激活主管、未改记录、未发模型请求；`.scratch/nexus-v1/activation-storage-check.txt`。这两项使用真实 JSONL provider，而非模拟错误类。
- 撤销源码实验后的最终全量 `npm test`：50 项，42 通过、0 失败、8 跳过，113.464 秒，正常退出；`.scratch/nexus-v1/activation-final-full-test.txt`。跳过的是 7 个原有付费 opt-in 与 Desktop opt-in；Desktop 单独运行通过。
- 正确官方 profile 的旧包差分：`activation-desktop-baseline-official-check.txt`，1 通过；`.scratch/nexus-v1/desktop-smoke-KURmUx/result.json`。使用 `desktop-smoke-Xq5oW8/dsh-nexus-0.2.0.tgz`，该包保留 unitBase 的错误类判定。
- 最终当前构建：`npm run build` 后，PowerShell `$env:NEXUS_DESKTOP_SMOKE='1'; node --test tests/desktop.test.mjs`，1 通过，约 12 秒；`.scratch/nexus-v1/activation-desktop-official-green.txt`、`desktop-smoke-cCMKrx/result.json`，同目录有安装日志、两阶段 Host 日志、原生输入截图与结构快照。
- 撤销源码实验后的 `npm run typecheck`、`npm run build`、`git diff --check` 均通过；`node --test --test-name-pattern='storage|persistence|test Host cleanup' tests/profile.test.mjs tests/host-process.test.mjs`，4 项通过、0 跳过；`.scratch/nexus-v1/activation-final-seams.txt`。

官方冒烟核对加载模块来自本次隔离 profile、加载回调与安装包一致、安装代码 SHA-256 等于当前构建、Host 识别主管 scope。第一进程从空记录启动，使用真实客户端原生发送按钮，受控 Realtime 返回 `DESKTOP-RESTORE-ACK`，完成轮次落在原生 journal。释放插件后通过原生读接口核对所有事件。第二进程使用同一 home，恢复相同主管身份、原生 header、型号和完整历史前缀；用户输入与 turn/start 仅各一条，无自动模型请求，总请求数为 1。

早先失败证据 `activation-desktop-red.txt`、`activation-desktop-green.txt`、`activation-scope-exact-diagnose.txt` 均保留在忽略目录中；其中名为 green 的旧文件实际失败，不能作为通过证据。

## 边界与 instanceof 审计

主管使用的 `SessionPersistenceNotFoundError` 是唯一相关 Host 错误类判定；正确官方 peer 环境中验证了首启与恢复，因此保留原实现。其余 `instanceof` 均为插件本地 `RealtimeFailure`，不跨 Host SDK 构造器。错误类公开 `name`、`sessionId` 可用于诊断，但没有采用字符串兼容兜底。

本次仅受控模型和无头原生界面；未验证实际模型、物理麦克风/扬声器或用户 Desktop 通话，未安装用户 profile。票 05/06 的原有真实模型与实机边界不变，票 07–11 未实施。新的 opt-in 缺少固定官方 CLI 时明确 skip；不能将 skip 解释为 Desktop 验收。

## 修复轮 1：根进程提前退出的清理缺口

标准轴与规格轴均提出同一 P2：初版 helper 仅在根仍存活时运行 `taskkill /T`，根在 readiness 前退出后跳过清理，detached 后代仍存活。两份意见分别处置为已修复、待原评审者复审确认；没有用一轴结论替代另一轴。

红测：`node --test --test-name-pattern='root-exit' tests/host-process.test.mjs`，根先 exit 1，ready 随后失败，断言 `owned descendant exited` 得到 `true !== false`；`.scratch/nexus-v1/cleanup-round1-red.txt`。fixture 的 finally 仅清理它自己记录的 PID。

Windows 改为测试专用 `host-process.ps1` 生命周期 launcher。它先创建匿名 Job、设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 并把自身加入，再创建 Host，因此没有先启动后扫描/追认 PID 的竞态。Job handle 不可继承，不设置 breakaway；Host 根提前或正常退出时 launcher 跟随退出，操作系统关闭最后一个 Job handle、终止其后代。主动关闭只终止自己启动的 launcher，也触发同一清理。Job 创建、设置或分配失败会在创建 Host 之前报错，无静默降级或通用进程名兜底。依据微软[Job Objects 公开契约](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)，嵌套 Job 支持 Windows 8 / Server 2012 起；本轮实测 Windows 11。

launcher 显式转发 UTF-8 stdout/stderr，保留调用方 argv 或已有 cmd.exe verbatim 引号，以及根退出状态。根结束后各等待输出 EOF 最多 1 秒；后代继承管道也不会让 launcher 永久等待。实际 Host 的实时输出仍由本次 Host 产生。POSIX 分支在根已退出时仍清理自己的独立进程组；当前 Windows 主机不能实测该分支，仅覆盖同组后代，不声称涵盖自行脱离进程组的 Unix daemon。

- `node --test tests/host-process.test.mjs`：5 通过，覆盖主动关闭、readiness 失败、根提前 exit 1、根正常 exit 0、提前退出且后代继承管道；每项均验证自有根/后代消失、无关兄弟存活、中文与嵌套引号输出正确；`.scratch/nexus-v1/cleanup-round1-green.txt`。
- PowerShell `$env:NEXUS_DESKTOP_SMOKE='1'; node --test tests/desktop.test.mjs`：1 通过，12.667 秒；`.scratch/nexus-v1/cleanup-round1-desktop.txt`、`desktop-smoke-7IDiFy/result.json`。通过真实官方 CLI 打包/安装及原生输入、新进程恢复，沿用所有包身份/hash/主管型号/历史/无自动请求断言，证明 launcher 的 cmd 引号与输出转发兼容。
- `npm run typecheck`、`npm run build`：通过。
- 本轮最终 `npm test`：53 项，45 通过、0 失败、8 跳过，113.908 秒，正常退出；`.scratch/nexus-v1/cleanup-round1-full.txt`。`git diff --check` 通过；未重跑付费模型或操作用户安装。
