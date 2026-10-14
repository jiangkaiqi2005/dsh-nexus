# 票 11：干净安装与完整场景交付验证

2026-10-11，用户明确“开始吧”，授权执行票 11，取代票中历史 draft / 本轮不执行文字。固定 unitBase：`a1ae824e2f8893219533793609f20def09183bcb`。范围为干净 profile 安装、独立 tgz、安装使用说明及受控组合验证。产品运行代码保持票 13 的 `434f75e` 构建；没有修改 Host、Desktop、Qiyu 或生产 profile，没有读取真实凭据或新增付费模型请求。

本次完成的是交付准备与受控检查；真实模型、真实 worker 和物理音频的一次连续完整场景仍待用户执行，不将脚本流程记为整票通过。票 07 / 08 / 09 的已有用户交接验收及票 10 的最终用户关闭结论保留；票 13 于 2026-10-11 用户确认三项修复通过；票 12 于 `a1ae824` 接受收尾、剩余实机项目免验，未执行项未转记通过。本次不要求用户重新逐票验收这些前置。

## 干净安装与受控组合边界

`tests/clean-install.test.mjs` 从真正空的隔离 DSH_HOME / DSH_AGENTS_HOME 开始，由 Desktop **0.2.0-rc.2** 自带官方 CLI 的 `--from-default-profile web --dump-default-config` 初始化，再由 `plugin --profile nexus-scenario add <实际 npm pack tgz>` 安装。使用官方 Web composition、实际 Host 与原生客户端，不手工构造核心 Context；没有从开发目录链接 Nexus 的运行代码。只为观察与脚本化 worker 注册一个隔离测试插件，不进入交付包。

每个包文件限定为运行 JS/类型声明、客户端、Typert、metadata、locale、SVG 和 README；逐个读取隔离安装目录，与本次打包输入作 SHA256 核对，保存 `installed-manifest.json`。Host 探针核对实际 loader 的 `apply` 就是隔离安装的 `dsh-nexus` 导出。官方生成的 `autoInstallPeers: false` 保持不变，不自动安装另一套 Host SDK。

主管模型为本地脚本 Realtime WS，worker 为本地 `LlmAdapter`。语音由 Windows SAPI 离线合成并通过 Edge 假采集设备进入真实客户端 PCM 链路；脚本端点按 PCM 能量检测到开口后发送**预定**转写和工具调用，不执行真正语音识别，不证明真实模型自主选择工具。回复音频也为合成数据，经真实 Web Audio 播放，不能证明物理扬声器听感。

两个普通会话在任务前由原生 SessionController 创建并手动命名；不是 Nexus 创建的会话或 subagent。修复 adapter 先等待测试放行，用户在执行中改要求后，在后续原生 step 领取 steer。它通过原生 `read`、`pwsh`、`write` 修改临时工作区：初始格式化函数把 0 误显示成 missing；最新要求为 0 显示 zero。原生 pwsh 运行实际 `node --test`，先得到失败，写文件后再次通过。审查会话独立读取文件并运行同一测试。主管依据实际回流的 PASS 消息安排脚本中的审查与最终文字，脚本顺序仅属于 fixture，产品没有硬编码修复循环或另一个主管。

本机原生 Windows ACL sandbox 无法 provision，首次实际 pwsh 得到 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(...)`。沿用已有测试的公共 `setSandboxMode`，只为两个一次性 fixture worker 配置完全权限执行固定本地命令；没有修改用户权限配置。因此本场景不证明 workspace-write Windows ACL sandbox 正常。独立 Host 的环境删除 `NODE_TEST_CONTEXT`，避免从上层测试继承后，原生 pwsh 的子 `node --test` 被 Node 当成递归测试而跳过。

| 组合步骤 | 实际观察与断言 |
| --- | --- |
| 干净首次使用 | 原生侧栏打开唯一 Nexus，idle；麦克风请求为 0，自动语音默认关闭。 |
| 既有会话修复 | 主会话原生输入框发送目标，脚本 WS 工具调度实际使 repair running；不是仅记录工具接受。 |
| 执行中语音改要求 | 点击接通，live；真实客户端非零 PCM 上传，脚本回复播放；`nexus_send_session` 返回 delivery=steer，ZERO-WORD 消息以 user / via=nexus 进入修复会话后续 step。 |
| 挂断与文字继续 | track 全部 ended、界面 idle；原生输入框的 TEXT-CONTINUE 得到文字回应。放行 worker 后修复与审查继续。 |
| 实际修复与独立审查 | 原生 read/write/pwsh 产生真实文件和测试输出，修复先 fail 1 再 fail 0，另一个普通会话独立测试并返回 REVIEW-PASS。 |
| 最终有依据的文字 | 审查终态自动回主会话，SCENARIO-COMPLETE 文字出现；所有 agent idle 后采证并关闭原生 writer 冷读。挂断后的线上输出音频数不增加。 |

## 检查与证据

证据保存在忽略目录 `.scratch/nexus-v1/`。失败探索不删除、不改记产品红：

- `ticket11-scenario-first.txt` / `ticket11-scenario-P80XoC`：最终文字等待超时，repair 实际 pwsh 的 ACL 失败，worker 如实返回 REPAIR-FAIL，没有伪造审查成功。
- `ticket11-scenario-second.txt` / `ticket11-scenario-tFLViX`：环境继承 NODE_TEST_CONTEXT，子测试被 Node 跳过，未记实际测试通过。
- `ticket11-scenario-third.txt`：实际流程完成，证据断言错误读取 user/message 中不存在的 step 字段失败。改用前一条公开 step/start 确定当前步骤，没有放宽后续 step 要求。
- `ticket11-scenario-green.txt` / `ticket11-scenario-fugAin`：初版场景 1 passed / 0 failed，23.425 s。此版安装后手动选择 Web bundles，后续改为官方模板初始化，不作为最终交付命令的唯一依据。
- `ticket11-scenario-official-init.txt` / `ticket11-scenario-XKi2zr`：新的包白名单漏掉已有 `.d.ts` 声明，审计失败；仅补上声明文件后复跑。
- `ticket11-scenario-official-green.txt` / `ticket11-scenario-58bKdJ`：官方模板初始化与逐文件安装哈希审计版场景 1 passed / 0 failed，23.867 s。最终版另补全 worker 修改前的真实失败测试，以及采证前等待全部 native turn idle。
- `ticket11-delivery-20261011/desktop-and-scenario.txt` / `ticket11-scenario-OL6c9o`：Desktop 打包冒烟通过，组合流程完成后新增断言失败；实际子测试输出是 Node 默认 spec 格式的 `ℹ tests 1`，断言误按 TAP 的 `# tests 1` 筛选，得到 0 条。改为匹配报告内 tests / fail 数，并额外要求初次测试实际 exit code 1，仍要求随后 fail 0。
- `ticket11-delivery-20261011/npm-test.txt`：首次完整套件 103 tests / 90 passed / 1 failed / 12 skipped，393.319 s，exit 1。既有 `official Host new-process restore: race` 首 PID 打印官方 Web URL 后退出，未生成任何 phase 报告；没有 stack，原因未定位，不能据此断定是文件读取竞态。
- `ticket11-delivery-20261011/restore-race-rerun.txt` / `restore-race-1791726000067`：未修改恢复测试或产品代码，单项重跑 1 passed / 0 failed，18.303 s。首轮全量失败仍保留，未转记为完整套件通过。

最终独立打包检查 `ticket11-delivery-20261011/desktop-and-scenario-rerun.txt`：2 passed / 0 failed / 0 skipped，25.864 s，exit 0。组合目录为 `ticket11-scenario-Z11384`（`initialize.log`、`install.log`、`pack.json`、`installed-manifest.json`、`host.log`、`wire.json`、`result.json`、`scenario.yml`、`scenario.png`）；独立 bundled CLI 两 PID 原生重启目录为 `desktop-smoke-X38WmE`。最终场景断言实际测试先失败 exit 1 再通过，独立审查通过，主管固定型号、所有原生 turn 完成并 idle 后采证。

交付目录：`.scratch/nexus-v1/ticket11-delivery-20261011/`，包含 `dsh-nexus-0.2.0.tgz`、`pack.json`、逐文件 `bundle-manifest.json`、配套 `INSTALL.md` / `README.md` 与检查日志。独立 tgz 的 SHA256 为 `64064c92c9ca61e7f9408e22c59237ec7f328d979afef52c82d1a287aeee5990`，SHA1 为 `ba62f08f639232d0dc7222b56a7cd194e5154a29`；26 文件，压缩 52162 bytes，解包 180240 bytes。两个最终 opt-in 各自重新 npm pack 得到的 SHA256 均与交付 tgz 相同。准确 peers 为所有 DSH 包 `0.2.0-rc.2`、Cordis `4.0.4`、Schemastery `3.18.4`；运行依赖 ws `8.22.0`，完整清单见 manifest。

协调者另只读核对生产已安装的 25 个运行/metadata 文件（排除 README），全部与交付 manifest 的 SHA256 相同，差异数 0。因此本次没有产品运行改动，不需再次安装到生产 Desktop。包内容审计也未发现凭据、fixture、源码参考副本或验证记录；运行数据与测试证据保留在隔离忽略目录。

| 检查 | 实际结果 |
| --- | --- |
| `npm run typecheck` | exit 0，`ticket11-delivery-20261011/typecheck.txt`。 |
| `npm run build` | exit 0，`ticket11-delivery-20261011/build.txt`；运行构建与现装版本一致。 |
| 新 fixture `node --check` / `git diff --check` | exit 0。 |
| 最终打包组合与独立重启冒烟 | 2 passed / 0 failed，exit 0，见上述双 opt-in 日志。 |
| 完整 `npm test` | 第二次 103 tests / 91 passed / 0 failed / 12 skipped，383.495 s，exit 0，`ticket11-delivery-20261011/npm-test-rerun.txt`。既有恢复 race 及其它恢复场景均通过；首次红和未定位原因仍保留。12 项跳过为需要真实模型或 opt-in 的测试，双 opt-in 已单独执行通过。 |

## 独立双轴评审

2026-10-11，协调者安排两个独立只读代理并行评审同一固定快照：`reviewBase = a1ae824e2f8893219533793609f20def09183bcb`，`reviewHead = b3684a2cd4611a785093e40ce572c7f5c1fa814f`。范围为上述 base 至 head 的六个票 11 文件，以及对应 Spec、设计、标准与证据记录。

| 评审轴 | 结论与处置 |
| --- | --- |
| 标准 | `approve`，`issues: []`。变更范围、隔离进程清理和证据表达符合现有要求；CLI command helper 的局部重复符合已有测试风格，不为本次交付增加跨测试抽象。 |
| 规格 | `approve`，`issues: []`。干净安装、独立包、用户指南与受控组合验证满足本次准备单元，可交用户连续验收；真实模型、真实 worker 与物理音频组合仍待执行，不能将整票 11 关闭。 |

评审修复轮数为 **0**：没有待修复发现，协调者采纳两轴结论。测试结果依据实施代理实际执行留下的上述日志；协调者另只读核对完整测试统计、打包文件清单、包哈希、准确依赖版本、最终组合截图与现装 25 文件一致性。评审没有再次运行完整套件，也没有新增真实付费模型或物理设备验证，不能把静态评审表述为这些场景再次通过。

此后仅增补本评审记录，不修改 README、指南、fixtures 或运行代码，交付 tgz 与哈希保持不变；记录提交后由原两轴复核文档与结论一致性。本次实施与初评完成的是“交付准备与受控组合验证”单元，整票关闭条件仍见下节。

## 用户验收与保留边界

用户说明为 [安装与使用](../../installation-and-use.md)，独立交付目录配套 `INSTALL.md`，仓库 README 只保留产品介绍与入口。包不含内部验证文档、fixture、sessions、凭据或官方源码参考副本。

待用户按指南“连续验收一次完整任务”执行一条流程：两个已有普通会话 → 修复与审查 → 执行中语音交流与改要求 → 挂断 → 文字继续与最终汇报。本次受控检查无法覆盖模型自行理解新目标、真实 coding worker 的修改与审查质量，或物理设备连续交流。用户先前通过的分项不转记为这条组合已完成。

最终 bundle 的自动语音一次、打断、客户端关闭与重启恢复等回归来源在最终检查中区分：常规完整套件使用当前构建；独立 bundled CLI 冒烟验证打包插件的原生输入、项目查询与两 PID 重启。构建的 25 个运行/metadata 文件与现装版本及最终包相同，前置已有用户验收关联到该运行版本，但不能据此把所有媒体用例宣称为本次在 Electron shell 或最终安装包中重测；票中该条仍保留未勾，不要求用户重新逐项验收前置。

其它保留项：真实 DashScope 网络恢复实机测试按票 10 用户决定未做；票 12 自动压缩、通话中压缩和真实摘要字段核对按其免验裁定保留；全新机器/VM、其它平台和版本没有本次验证。此次不启动用户 Desktop、不重新安装生产包、不推送或发布。
