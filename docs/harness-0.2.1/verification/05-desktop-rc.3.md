# Desktop 0.2.1-rc.3 适配验证

日期：2026-10-29。Nexus 从 0.2.1 更新为 0.2.2，目标是本机已升级的 DeepSeek Harness / Desktop 0.2.1-rc.3。

## 适配范围

- 开发 CLI 与所有直接引用的 `@deepseek-ai/dsh-*` SDK 精确固定为 `0.2.1-rc.3`，重新生成锁文件。`npm ci --ignore-scripts` 可复现这套依赖。
- 保留原有 peer 与 `engines.dsh` 区间 `>=0.2.1-rc.2 <0.3.0-0`，Cordis 仍为 4.0.5。上一版 rc.2 的运行验证见[原验证记录](01-version-range-and-fixtures.md)；本次运行验证只针对 rc.3。
- 新增 `tests/compatibility.test.mjs`：检查开发 Host 的实际版本、插件与 Host 解析到的 SDK 版本和模块身份，并通过原生兼容门检查支持与拒绝的版本。
- 更新中英文 README、安装指南与安装包版本。没有改动主管、派活、上下行协议或客户端界面实现。

只升级 CLI 会保留锁文件中的 rc.2 SDK；仅按宽泛的 peer 区间重新解析又可能引入更高的预发布版本。上述回归检查已在混版依赖下实际失败，提示 `dsh-agent` 为 rc.2 而 Host 为 rc.3；精确固定开发 SDK 后通过。最终锁文件内 296 个 Harness 包条目全部为 rc.3。

## 环境与结果

Windows，本机 Node.js 24.15.0、TypeScript 5.9.3、无头 Edge。Desktop 自带 CLI 为 `D:/DeepSeekHarness/resources/runtime/cli/bin/dsh.cmd`，实际 `--version` 为 `0.2.1-rc.3`；其内置运行时清单声明 Node.js 24.21.0。

测试在独立副本 `E:/Agent/nx-rc3-20261029` 执行，使用独立 `DSH_HOME`、本地受控模型与语音端点，不复制日常会话或凭据。测试副本位于日常仓库之外，避免 Host 的 Git 快照把未跟踪的宣传素材纳入每轮测试。

| 检查 | 结果 |
| --- | --- |
| `npm ci --prefer-offline --ignore-scripts --no-audit --no-fund` | 通过 |
| `npm run typecheck`、`npm run build` | 通过 |
| `node --test tests/compatibility.test.mjs` | 2/2 通过 |
| `npm test` | 148 项：133 通过、0 失败、15 跳过；22 分 45 秒 |
| Desktop CLI 打包安装、级联完整流程、干净 profile 场景 | 0.2.2 交付包 3/3 通过；49 秒，包的 SHA256 与交付文件一致 |

全套中的 Desktop 用例默认按开关跳过，已通过 `NEXUS_DESKTOP_SMOKE=1` 单独执行上述三项。日志保存在 `.scratch/harness-0.2.1-rc.3/full-test.log` 与 `desktop-smoke.log`。

原生兼容门允许 `0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1`、`0.2.5`，拒绝 `0.2.0-rc.2`、`0.3.0-rc.1`、`0.3.0`。这项检查验证版本声明，不代表已经对所有允许版本做过运行验收。

## 安装包与本机更新

- 包：`.scratch/harness-0.2.1-rc.3/delivery/dsh-nexus-0.2.2.tgz`，31 个文件，76036 字节。
- SHA256：`aef6e7378f95bcdcc446a957dfa22c9153285daee622fa9aa4966f69ff3760ee`。
- 本机更新前，旧版插件与 profile 安装配置已备份到 `.scratch/harness-0.2.1-rc.3/backup-before-0.2.2/`。
- 使用 Desktop 自带 CLI 将本机 `desktop` profile 的 Nexus 更新为 0.2.2，安装退出码为 0；已逐一核对安装后的 31 个文件，均与验证过的构建一致。其它插件依赖和 `dsh` profile 声明保持一致。
- 安装日志与核对结果分别为 `.scratch/harness-0.2.1-rc.3/desktop-update.log`、`installed-verification.json`。本次没有发布 GitHub Release。

自动检查使用假音频设备，不代替物理麦克风、真实 DashScope 和实际默认模型的连续验收。本机另外安装的 Claude Hooks 与 hook-protocol 仍是 rc.2，新 Desktop 报告它们不兼容；它们属于独立插件，不在本次 Nexus 适配范围内。
