# cascade-voice 01–06 实施与评审报告

2026-10-14，用户已明确继续实施全部剩余票据，撤销此前停在 04 的安排。当前 01–05 共 5 票已经实施并双轴闭环；06 的实施、自动检查、独立安装与标准/规格双轴初评均完成，无未决评审问题，仅待用户本人实机反馈，整票尚未关闭；**不宣称 6 票工作流全部完成**。正式修复累计 2 轮，03、05 各 1 轮；06 为 0。提交在 main，没有推送、PR、发布或生产部署。本次纯文档收束继续交原两轴复核。

各票由独立实施代理负责代码、自验与提交；标准/规格由每票恰好两个独立只读代理并行审查，同一 unitBase、同一冻结 reviewHead，修复沿用原评审对。下面的检查依据实施代理真实日志；协调者只读核对提交、统计、包和评审，没有重复完整集合。

| 票 | 固定 unitBase | 实施/修复及最终文档提交 | 双轴与正式修复 |
| --- | --- | --- | --- |
| 01 原生归档 | `13a45c1a6dc5347700d8870a4a971d8cf87cd826` | `27d64e1f0a1c464bfd962be896391e5c30e136cd`；最终 `24ceec685e326c9c9f08693a3cf31d2dc89703bd` | 标准/规格 approve，无未决，0 轮。 |
| 02 原生默认主管 | `24ceec685e326c9c9f08693a3cf31d2dc89703bd` | 预重构 `9ebf93674d049dcac6c31149f79b99eb2d74168d`；实施 `044a5a0e97d08fdfe240d82500441aa0baa95fd5`；最终 `f53ff2a6eda9f76be7cde2a11441b74bc9c59017` | 标准/规格 approve，无未决，0 轮。 |
| 03 逐句朗读 | `f53ff2a6eda9f76be7cde2a11441b74bc9c59017` | 初评 `b5ff4dfe2966c1ed1dfdb0430459149a3c132e9c`；修复 `65d8fe2fb70d591f5df2b8e41ac193541e94830d`；最终 `c605c6791add524c5a4300a65a21b288ace5bd56` | 标准初评 approve；规格 P2 fixed，原两轴 r1 approve，无未决。 |
| 04 点按识别 | `c605c6791add524c5a4300a65a21b288ace5bd56` | 实施 `815dbf7bd6c3603df9f8839a08b790f902bcb12e`；最终 `e03c44f0ec6edeb5e4e11925650e708c51454e14` | 标准/规格 approve，无未决，0 轮。 |
| 05 插话/缓存 | `e03c44f0ec6edeb5e4e11925650e708c51454e14` | 初评 `811ea3430b158c7091e7c2e81ec2ed5c44fd92fe`；修复代码 `0798595f01e8c1dea957201885796ea4751d63cc`；r1记录 `6ccd9556cfcaefd7e834e26b31506c62d97a17f2`；最终 `edc97d835966b30a4976b6d944a771ab18894de9` | 标准初评 approve；规格 P1 fixed，原两轴 r1 与文档复核 approve，无未决。 |
| 06 生命周期/安装 | `edc97d835966b30a4976b6d944a771ab18894de9` | 实施与初评 reviewHead `e8488d3a8c7cfb475ef825c5740b3a261394f3b7`。本次纯文档增量交原两轴复核。 | 标准/规格 approve、issues: []，无未决，0 轮；用户实机未完成，不关闭票。 |

## 各票实施与验证

01 调用原生 archiveSession(stopActivity:true)，拒绝主会话，不存在如实报错；提示说明归档不删除，停止请求不冒充全部结算。原生 turn/job/schedule 与撤销后保留历史实测通过。typecheck/build、归档聚焦和全套 104 项/92 通过/12 跳过/0 失败通过。[01记录](01-archive-work-sessions.md)

02 先在预重构版本验证原 Realtime 的 104 项全集与 voice 27 通过/5 跳过，再增加级联。每步原生默认 provider/model/effort、结构化工具历史、缓存用量与回复增量均保留，共用主管轮次/结果/steer/压缩。模式下次接通生效。typecheck/build 和最终全套 114 项/102 通过/12 跳过/0 失败。[02记录](02-cascade-text-supervisor.md)

03 媒体准备接通、逐句 WS PCM24k、第一句在模型生成时已播，工具不等语音，挂断只停媒体。规格初评 P2：后来 TTS 失败不应清空先前成功待播回复；r1 按 replyId 清理，真实 red/green 与前成功自然结束/失败条停止/下条恢复通过，Realtime 无 ID flush 保留。typecheck/build，聚焦 14 通过/1 跳过，冻结全套 119 项/106 通过/13 跳过/0 失败。[03记录](03-cascade-spoken-replies.md)

04 点按16k PCM、Host封装WAV原生多模态ASR；非空原生user/steer，空错零回合，真实60秒墙钟，挂断/断线丢晚结果与配置保存通过。两次旧默认并发完整运行失败，按证据停止重复；同冻结集合实际执行 **`node --test --test-concurrency=1 tests/*.test.mjs`** 得 126 项/112 通过/14 跳过/0 失败、957.943秒。之后只把 scripts.test 改为该精确命令并核对 JSON/等价性，没有为元数据变化再执行 npm test；不能把旧并发失败转记成功。[04记录](04-cascade-tap-to-talk.md)

05 本地立即停止/实际samples、官方供应商句子/PCM边界、单notice、主管/工具不中止、录音Host缓存和在途新reply按序释放均通过。规格初评 P1：官方 original_text 在 payload.output，与 sentence 同级；仅纠正fixture先在旧parser有效红，runtime一行正式字段修复后green，原两轴r1认可。冻结 `npm test` 最终 135 项/121 通过/14 跳过/0 失败、1036.068秒。旧账户测试瞬态窗口用真实公开 AudioContext.suspend 固定，未弱化原账目/notice/超时；首次 races 原因仍未知。[05记录](05-cascade-barge-in.md)

06 共用已有生命周期，无新增 runtime。真实Host/Edge 六项覆盖自动一次、refresh/导航不重开、context连续、唯一媒体、关闭/实际WS断线Host文字继续、准确许可/设备/autoplay/语音服务失败。README/指南/包描述更新默认级联、点按/60s/插话、Host凭据、原生归档和 next-connect。最终 tgz 经官方 Desktop rc.2 CLI 干净安装，32文件每项SHA相等、loader与native scope识别，通过真实native read/pwsh/write红绿/独立审查及挂断结果/归档受控场景。显式四文件串行9项全过95.170秒；随后补强非空真实下行observer的6项全过49.737秒；最终冻结真实 `npm test` **142项/127通过/15默认跳过/0失败、1089.6949433秒，exit0**。typecheck/build/新增JS语法/diff-check通过，Desktop无需因仅observer补强重复运行。standards_06/spec_06 初评均 approve、issues: []，独立核对同包32文件零差异及实际工具/journal、检查日志，无未决，0修复轮。详见 [06记录](06-cascade-lifecycle-and-install.md)。

## 交付与剩余验收

独立包 `.scratch/cascade-voice/06-delivery-20261014/dsh-nexus-0.2.0.tgz`，SHA256 `d5b81c7bd7dc929fb0dc80aca632fcd9542eb63428f033e0e0cfbd01a32868fc`。同目录有manifest、INSTALL、ACCEPTANCE、Prepare/Start脚本及无fixture独立 manual-data profile；已安装，autoVoice关闭，没有启动真实模型。受控smoke profile不能当真实验收环境。

票06明确要求实机由用户本人操作，只记录其反馈。本人须用实际默认模型与真实DashScope完成“点按派活/朗读 → 插话 → 挂断文字结果 → 原生归档”。尚无反馈，最后清单未勾；真实opt-in默认跳过、物理麦克风/扬声器、Electron实机及全新机器/其它平台没有本次结论。流程见 [安装与使用](../../installation-and-use.md)。

历史非阻塞限制保留：03早期非冻结UI入口未载入；04旧并发titles phase2原生0xC0000409及Realtime重接异常；05早期loader URL迟滞、首次races超时的原因仍未知。本票最终串行过旧titles/races/各播放账目，不声称未知根因已修复。06fixture探索的配置/catalog/locator/实际传输观测问题与短暂重叠runner如实记在06记录，不冒充产品red或正式review修复。WinACL fixture权限例外也不证明原生workspace-write sandbox正常。

此前 [01–04阶段报告](implementation-report-01-04.md) 保留当时 stop04 的历史结论，不覆盖或改写；本报告记录新授权后05–06进展。当前没有其余待实施票，06实施/自动/交付初评已通过，只等用户实机反馈；本次收束文档仍须原标准/规格评审对复核，未重复已通过的 runtime 全集，包字节保持不变。
