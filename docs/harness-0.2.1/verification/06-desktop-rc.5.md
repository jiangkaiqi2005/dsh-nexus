# Desktop 0.2.1-rc.5 适配验证

日期：2026-10-31。Nexus 从 0.2.2 更新为 0.2.3，目标是本机已升级的 DeepSeek Harness / Desktop 0.2.1-rc.5。

## 适配范围

- 开发 CLI 与所有直接引用的 `@deepseek-ai/dsh-*` SDK 精确固定为 `0.2.1-rc.5`，重新生成锁文件。锁文件中顶层 `@deepseek-ai/dsh-*` 包 295 个，全部为 rc.5，没有 rc.3 条目。
- 保留原有 peer 与 `engines.dsh` 区间 `>=0.2.1-rc.2 <0.3.0-0`，Cordis 仍为 4.0.5。上一版 rc.3 的运行验证见[原验证记录](05-desktop-rc.3.md)；本次运行验证只针对 rc.5。
- 逐文件比对 rc.3 与 rc.5 的 19 个直接引用 SDK 包，以及 `dsh-sandbox-policy`、`dsh-host-webserver`、`dsh-app-boot`：除 `package.json` 版本号外，lib 代码完全一致。`@deepseek-ai/dsh` 是没有运行逻辑的聚合包，未纳入逐文件比对。因此本次没有修改主管、派活、上下行协议、断线恢复或客户端界面实现。
- `tests/compatibility.test.mjs` 的原生兼容门接受版本加入 `0.2.1-rc.5`。
- 更新中英文 README、安装指南与安装包版本。

## 环境

Windows。Desktop 自带 CLI 为 `D:/DeepSeekHarness/resources/runtime/cli/bin/dsh.cmd`，实际 `--version` 为 `0.2.1-rc.5`；Desktop 内置运行时清单声明 Node.js 24.21.0，内置的 `@deepseek-ai/dsh-*` 与 client UI 均为 rc.5。

全套测试在独立副本 `E:/Agent/nx-rc5-clean-20261031` 执行，使用独立 `DSH_HOME`、本地受控模型与语音端点，不复制日常会话或凭据。副本不含 `.git`、`promo` 等日常工作区内容。

测试运行时使用独立的 Node **24.22.1**（libuv 1.52.1）。测试通过 `process.execPath` 启动 Host，因此整套 Host 与测试进程使用同一个 Node。选择 24.22.1 的原因：系统 Node 24.15.0（libuv 1.51.0）在 Windows 上有已确认的原生 TCP 连接崩溃（[nodejs/node#63620](https://github.com/nodejs/node/issues/63620)，修复见 [PR 62561](https://github.com/nodejs/node/pull/62561)）；早期用 24.15.0 跑全套时出现宿主以 `0xC0000409` 退出的随机失败，独立纯 Node HTTP 压测也能复现，与 Nexus 无关。24.22.1 比 Desktop 的 24.21.0 新，libuv 同代；在它上面全套与断线子集均未再出现该崩溃。诊断记录见本机 `.scratch/rc5-diagnosis/diagnosis.md`。

## 结果

| 检查 | 结果 |
| --- | --- |
| `npm ci --prefer-offline --ignore-scripts --no-audit --no-fund` | 通过，锁文件 295 个顶层 dsh 包均为 rc.5 |
| `npm run typecheck`、`npm run build` | 通过（Node 24.22.1） |
| `node --test tests/compatibility.test.mjs` | 2/2 通过 |
| `node --test --test-concurrency=1 tests/*.test.mjs` | 148 项：133 通过、0 失败、15 跳过；22 分 38 秒 |
| Desktop CLI 打包安装、级联完整流程、干净 profile 场景 | 0.2.3 交付包 3/3 通过；44 秒，包内 tgz 的 SHA256 与交付文件一致 |

全套日志在测试副本的 `.scratch/clean-node-full.log`，Desktop 冒烟日志在 `.scratch/desktop-smoke-node.log`。Desktop 用例默认按开关跳过，本次以 `NEXUS_DESKTOP_SMOKE=1` 单独执行。

原生兼容门允许 `0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.5`、`0.2.1`、`0.2.5`，拒绝 `0.2.0-rc.2`、`0.3.0-rc.1`、`0.3.0`。这项检查验证版本声明，不代表已经对所有允许版本做过运行验收。

## 安装包与本机更新

- 包：`.scratch/harness-0.2.1-rc.5/delivery/dsh-nexus-0.2.3.tgz`，31 个文件，76069 字节。
- SHA256：`19bddafecf02ef95daadaf7e1e03172c5fe7a2608cc0e43e557151c399fa7dca`。
- 本机更新前，旧版插件与 profile 安装配置已备份到 `.scratch/harness-0.2.1-rc.5/backup-before-0.2.3/`。
- 用 Desktop 自带 CLI 将本机 `desktop` profile 的 Nexus 更新为 0.2.3，安装退出码为 0；安装后的 31 个文件与 tgz 解包逐文件一致，`cordis.patch.yml` 与安装前相同，其它插件依赖保持不变。核对结果见 `.scratch/harness-0.2.1-rc.5/installed-verification.json`，安装日志为 `.scratch/harness-0.2.1-rc.5/desktop-update.log`。
- 安装时 Desktop 未运行；下次启动 Desktop 生效。本机另装的 Claude Hooks 与 hook-protocol 仍是 rc.3，rc.5 会在安装时报告它们不兼容；它们属于独立插件，不在本次 Nexus 适配范围内。
- 本次没有发布 GitHub Release。

自动检查使用假音频设备，不代替物理麦克风、真实 DashScope 和实际默认模型的连续验收。
