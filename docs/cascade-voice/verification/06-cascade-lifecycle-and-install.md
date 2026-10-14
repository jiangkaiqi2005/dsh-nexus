# 票 06：级联生命周期与独立安装验证

固定 unitBase：`edc97d835966b30a4976b6d944a771ab18894de9`。本次完成生命周期验证、独立包、官方 Desktop CLI 的干净安装及受控组合场景；实施已自验，尚待协调者固定提交快照后的标准与规格双轴评审。真实 DashScope、实际默认模型和物理设备的完整场景仍待用户本人反馈，票 06 尚未关闭。

## 实施与边界

票 01–05 的运行代码已共用 Host 自动启动状态、单客户端媒体占用和主管生命周期。新增验证证实级联可以沿用这套行为，因此本票没有另写一套生命周期，也没有修改 Realtime runtime 或旧测试。变更是三份级联测试/外部模型探针、README、使用指南和包描述；默认模型、点按录音、60 秒结束、插话、原生归档与模式下次接通说明在打包前完成。

`tests/cascade-lifecycle.test.mjs` 在隔离官方 Host、原生主会话及真实 Edge 操作，不替换 Nexus 内部方法。默认 LLM、HTTP ASR、WS TTS 是受控外部服务，麦克风为假设备，AudioBufferSourceNode 实际运行：

- 自动语音开启后一次接通；挂断释放轨道，refresh 和原生会话导航不再请求设备；手动重接后原生请求含此前用户与 assistant 历史。
- 第二个页面在获得设备前被 `CALL_BUSY` 拒绝，轨道与播放节点为零。关闭 owner 或实际关闭路由的 WebSocket 两侧后，Host 继续处理原生 worker 结果，输出文字，没有后续合成；另一个页面可手动接通且保留结果上下文。
- Chromium 实际权限拒绝、受控无设备以及浏览器真实 autoplay 限制分别显示 mic-denied、no-device、playback-blocked，不发起模型/识别/合成请求。接通本身不保持模型或语音服务连接。
- ASR 503 显示“没听清”，零用户回合；TTS task-failed 显示该条合成失败，文字完整保留，下一条恢复。按 Spec，已准备好的级联通话保持 live；live 表示媒体准备，不冒充服务已经握手或成功识别。
- 下行在公开 WebSocket 路由真正传输时采证，先断言非空，再检查 Host fixture key 没有出现在下行，避免空数组成为凭据不泄露的伪证据。

## 最终包与实际安装

交付目录：`.scratch/cascade-voice/06-delivery-20261014/`。`dsh-nexus-0.2.0.tgz` 的 SHA256 为 **`d5b81c7bd7dc929fb0dc80aca632fcd9542eb63428f033e0e0cfbd01a32868fc`**，SHA1 为 `1a53d2618efd5c519a22f3609297382ffca5839d`。32 个允许文件，压缩 62759 bytes，解包 227708 bytes。包仅含 dist JS/声明、客户端、Typert、locale、metadata、图标和 README，不含测试、profile、凭据、graph、scratch 或源码参考副本。版本仍为 0.2.0/private，未发布。

实际 CLI `D:/DeepSeekHarness/resources/runtime/cli/bin/dsh.cmd --version` 为 **0.2.0-rc.2**。`tests/cascade-install.test.mjs` 用它从空 DSH_HOME / DSH_AGENTS_HOME 开始，官方 Web 模板 `--from-default-profile web --dump-default-config` 初始化，再由官方 plugin manager 安装本次 tgz。维持官方 base/web/bundle composition 和 `autoInstallPeers: false`，没有重复安装原生 agent peer SDK。检查每一个包文件安装后的 SHA256 等于打包输入，loader.apply 等于安装包导出、实际模块路径位于隔离 profile，native scopeOf 能识别主管。不是开发 symlink 或单独 import 冒充 Desktop 打包加载。

最终受控组合目录 `.scratch/cascade-voice/06-installed-csIEAf/`，包 SHA256 与交付一致。场景为：浏览器点按录音 → 受控 HTTP ASR 上传 WAV → Harness 默认 normal/high 模型原生结构化派活 → 实际 PCM 朗读 → 点按插话、本地节点立刻停止、TTS 收到 cancel、原生 steer 交给运行中的 repair → 挂断 → native read/pwsh/write 继续真实修复 → 独立 review 测试 → 主管文字结果回流 → native archive。

两个 worker 是原生普通会话，使用原生 selectModel 固定各自模型；主管独自跟随 Harness 当前默认 install-supervisor/normal/high。临时 format(0) 初始实际返回 missing，native pwsh 的 `node --test` 第一次 fail 1、exit 1；native write 后第二次 fail 0，独立 review 也 fail 0。并非测试脚本直接写修复结果。只为这两个 owned fixture worker 使用既有 native setSandboxMode 完整权限，保留本机 WinACL provisioning 不可用的历史限制；子 Host 删除 NODE_TEST_CONTEXT，防止真实子测试被当成递归测试跳过。没有修改生产权限。

最终截图已目视：主会话显示 SCENARIO-COMPLETE、ARCHIVE-COMPLETE、语音未接通与 normal/high；原生归档 IDs 包含 repair。该图片和脚本选择不证明物理扬声器、真实 ASR 或模型自主决策。

## 实际检查与探索记录

日志位于 `.scratch/cascade-voice/`。本票完整集合只在最终冻结后运行一次，没有改变源码/断言/超时后用重复全集磨绿。

| 检查 | 实际结果 |
| --- | --- |
| `npm run typecheck` / `npm run build` | 各 exit 0，`06-typecheck.log`、`06-build.log`。之后只改 JS fixture/文档，没有改 TS runtime。 |
| 三个新增 JS 的 `node --check` | exit 0。 |
| 显式 `NEXUS_DESKTOP_SMOKE=1`，串行生命周期、新级联 clean、旧 Realtime clean、Desktop native 重启四文件 | 9 项、9 通过、0 失败、0 跳过，95.1701313 秒，exit 0；`06-final-focused.log`。新安装 14.793 秒，旧 Realtime clean 18.541 秒，Desktop 两 PID 原生恢复 12.623 秒。 |
| 补强真实非空下行 observer 后，再串行 lifecycle 文件 | 6 项、6 通过、0 失败，49.7374615 秒，exit 0；`06-lifecycle-observed.log`。9 项批次在 observer 补强前，Desktop 未为此重复运行；包字节没有变化。 |
| 冻结后的实际 `npm test`（精确 `node --test --test-concurrency=1 tests/*.test.mjs`） | **142 项、127 通过、15 默认跳过、0 失败，1089.6949433 秒，父进程 exit 0**；`06-full-suite.log`。包含补强后的新六项、01–05、所有旧 Realtime/native 回归。安装 opt-in 在默认集跳过，独立显式安装检查不改写该计数。 |
| diff-check 与最终安装/交付字节 | 无 diff-check 错误；每文件安装 SHA 与输入一致，新 clean 使用 NEXUS_DELIVERY_BUNDLE 核对同交付 tgz。 |

探索阶段的失败保留，不能根据日志文件名 green 判断成功：

- 首次 `06-lifecycle-first.log` 缺少 schema 必填 endpoint，Host 未激活，是 fixture 配置失败；`06-lifecycle-startup.log` 已自动 live/refresh off，但侧栏没有经 ctx.agents.create 创建的 worker，换为原生新建会话导航。期间旧失败 runner 尚在运行时误启动单例，核对 PID/CommandLine 后只终止该 owned runner 树；这两份探索不记串行正式通过。
- `06-lifecycle-green.log` 4 过/2 失败是 status locator 同时命中 native “已完成”和通话 CALL_BUSY；限定通话条后 `06-owner-focused.log` 的关闭分支通过，断线分支失败。
- Playwright setOffline 不证明既有 WS 已断；window.WebSocket 包装也未覆盖 native transport。`06-lifecycle-final.log` 5 过/1 失败不作为最终通过。改用公开 routeWebSocket 捕获并关闭实际 browser/server 两侧、阻止重建后，同断线/轨道释放/文字结果/重接断言在 `06-disconnect-transport.log` 通过，7.786 秒；没有扩大超时或改 runtime。其后完整正式 9 项 → observer 6 项 → npm 全集逐一结束后串行执行。
- 新 clean 初稿 `06-installed-first.log` 同样漏 endpoint，随后 `06-installed-second.log` 实际激活、派活、PCM/插话/挂断成功，但 worker 跟随后来切换的全局默认主管，journal 中有 unknown nexus_send_session，未执行 repair；不记组合通过。通过 native selectModel 固定 owned worker 的自身模型，`06-installed-worker-pin.log` 先暴露外部模型 catalog 未声明可用，补全真实外部 adapter catalog 后 `06-installed-model-catalog.log` 1 项通过、15.538 秒。最终正式批次再次以同 tgz 验证，保留真实工具失败/成功断言。

Graph 开始前 fast 刷新成功（1316 nodes/3867 edges）；tests 的 fast-pattern 覆盖缺口按实际定位源码读取。没有在 Host 集合运行期间重建索引。

## 双轴与用户实机

标准轴、规格轴：**待协调者在本次实施提交上启动**；正式修复轮为 0，不提前写 approve。之前 03、05 各正式修复 1 轮，总共 2 轮，与本票 fixture 探索无关。

票 06 原文：“**实机验收由用户亲自操作，验收结果只记录用户的反馈，不得自行宣称通过。**”因此只完成代理能够执行的代码、自动与实装工作，没有将最后实机清单勾选。用户入口是交付目录的 `ACCEPTANCE.md`、`Start.ps1` 和 `INSTALL.md`；另一个无 fixture 的 nexus-cascade-acceptance profile 已官方初始化并安装于交付目录 manual-data，autoVoice 默认关闭，尚未启动模型/真实服务，没有复制现用配置或真实凭据。受控安装 profile 含脚本模型和端点，不能用作真实验收环境。

用户须本人配置实际默认提供方/型号/思考强度与 Host DashScope 凭据，再走“点按派活与朗读 → 插话 → 挂断文字结果 → 原生归档”，仅反馈整条通过或失败步骤/可见错误。不收集 key 或完整带 token URL。正式步骤见 [安装与使用](../../installation-and-use.md)。

没有推送、PR、发布或生产 profile 部署，也没有真实付费请求。其它平台、全新机器、Electron 物理外壳与真实音色/听感没有本次结论。票 04 默认并发 Windows Host 退出、票 05 首次 races 超时、早期 URL 公告迟滞的未知原因保留；本次串行全绿不称这些根因已修复。
