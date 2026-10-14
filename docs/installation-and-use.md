# Nexus 安装与使用

本指南对应 Nexus 0.2.0、Harness / Desktop **0.2.0-rc.2**（Cordis 4.0.4）。其它版本、macOS、Linux 和全新 Windows 机器尚无本次兼容结论。运行时包的精确 peer 版本见包内 `package.json`；不要在 profile 自动安装另一套 Host peer SDK。

## 安装到现有 Desktop

首次使用 Desktop 时先正常打开一次，让它建立自己的 `desktop` profile，再正常退出。保存工作后，用 Desktop 自带 CLI 安装 tgz。以下路径对应本机安装位置；其它安装位置只需更改 CLI 路径和 tgz 路径。

```powershell
$nexusCli = 'D:\DeepSeekHarness\resources\runtime\cli\bin\dsh.cmd'
$nexusBundle = 'C:\Downloads\dsh-nexus-0.2.0.tgz' # 改成实际文件
& $nexusCli --version # 应为 0.2.0-rc.2
& $nexusCli plugin --profile desktop add $nexusBundle
```

安装退出码为 0 后，正常打开 Desktop，从侧栏底部 Nexus 进入主会话。npm 版 CLI 不管理 Desktop 保留的 profile。级联是本次新增行为，旧包需要替换为本次 tgz；版本号仍为 0.2.0，请按交付文件的 SHA256 核对实际字节。

安装器可能提示宿主 peer 未由 profile 的 pnpm 安装；rc.2 由实际 Host 提供这些包。保持官方生成的 `nodeLinker: hoisted`、`autoInstallPeers: false`。安装成功还需确认入口能打开、文字输入能执行；出现激活或版本错误时保留实际错误，勿通过自动安装 peers 或忽略版本检查来掩盖问题。

## 用干净 profile 打开 Web 客户端

请在新开的专用 PowerShell 窗口执行本节，使用完关闭该窗口，不改变日常终端的环境。下面设置的是该窗口及其 Host 子进程的环境，不修改系统环境变量。这是独立的数据目录，不复制现用配置、会话或凭据。只运行一次初始化命令；再次使用时省略 `--from-default-profile`。`--dump-default-config` 初始化官方 Web 模板并退出，不启动模型。

```powershell
$nexusCli = 'D:\DeepSeekHarness\resources\runtime\cli\bin\dsh.cmd'
$nexusBundle = 'C:\Downloads\dsh-nexus-0.2.0.tgz' # 改成实际文件
$env:DSH_HOME = Join-Path $env:LOCALAPPDATA 'NexusHarnessClean'
$env:DSH_AGENTS_HOME = Join-Path $env:DSH_HOME 'agents'
& $nexusCli --profile nexus-clean --from-default-profile web --dump-default-config | Out-Null
& $nexusCli plugin --profile nexus-clean add $nexusBundle
```

确认两条命令成功后，在同一 PowerShell 窗口启动。若尚未通过 Host 原生凭据服务配置 `DASHSCOPE_API_KEY`，可用隐藏输入提供本次 Host 的环境凭据；键值不写入插件、profile 或命令文字。关掉 Host 后本次环境凭据也清除，下次需再次提供。

```powershell
$nexusKey = Read-Host 'DashScope API Key' -AsSecureString
$env:DASHSCOPE_API_KEY = [System.Net.NetworkCredential]::new('', $nexusKey).Password
try {
    & $nexusCli --profile nexus-clean --port 0 --no-open
} finally {
    Remove-Item Env:DASHSCOPE_API_KEY -ErrorAction SilentlyContinue
    $nexusKey.Dispose()
    Remove-Item Env:DSH_HOME, Env:DSH_AGENTS_HOME -ErrorAction SilentlyContinue
}
```

在浏览器打开 Host 输出的本机 URL（包含访问 token，不要分享完整 URL）。首次说明结束后点击 Nexus。以上启动方式在本机自带 CLI 和隔离目录验证；浏览器使用本机 Host，语音与调度仍调用外部模型服务。

## 模型与语音

Nexus 默认采用级联模式，主管每一步跟随 Harness 当前默认模型、提供方与思考强度，使用原生结构化工具。先在 Harness 的原生模型设置登录或配置你实际使用的提供方，再选为默认模型与思考强度；Nexus 不另设主管模型。已有工作会话仍沿用各自模型。默认模型不可用时主会话照实报错，不会换一个模型假装完成。

识别默认 `qwen-audio-3.1-asr-flash`，端点 `https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`；合成默认 `qwen-audio-3.1-tts-flash`，端点 `wss://dashscope.aliyuncs.com/api-ws/v1/inference`，音色 `longanhuan_v3.1`。这五项可在 **设置 → Nexus** 修改。两项语音服务共用 Host 的 `credentialRef`，默认 `DASHSCOPE_API_KEY`；只填写引用名，勿把 key 写进插件配置。麦克风音频会交给识别服务，回复文字会交给合成服务，凭据明文不会发送到浏览器。

需要 Realtime 时，在 **设置 → Nexus → 语音模式** 切换，下一次接通生效；当前通话、任务和历史保持连续。Realtime 使用 `qwen3.8-omni-flash-realtime` 和 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`，端点与凭据引用通过原生插件配置设置。挂断后保持刚才已生效的模式，直到下次接通重新读取选择。

在 Harness 的原生模型设置中配置工作会话使用的模型，并选为默认模型；每个已有会话也可沿用自身已选模型。默认摘要模型走 `deepseek-account/deepseek-flash`，需要在 Harness 登录 DeepSeek 账号，或在 **设置 → Nexus** 另选已配置的摘要模型；不可用时压缩如实失败，不自动换模型。摘要默认使用模型可用的最低思考强度。

先在 Nexus 输入一句文字确认默认模型能回复，再点击“接通语音”，按系统提示允许麦克风。确认麦克风的硬件开关已打开、系统选的是正确输入设备。级联的“已接通 Nexus”表示本客户端麦克风和播放已经准备好，不保持常驻模型或语音服务连接；真实识别与合成在需要时才请求。Realtime 的“正在接通”还会等待模型握手。通话中切到工作会话、其它项目或折叠侧栏，右下角保留状态与挂断按钮。

级联通话点击“开始录音”再点击“结束录音”，识别文字会直接进入主会话，不需要再次确认；60 秒自动结束。状态依次显示录音中、识别中、思考中和朗读中。朗读时开始录音会立即停止播放，只按实际听完的完整句子告知主管；已发出的工具和工作继续，运行中的新要求按原生引导交付。录音期间的新回复暂存，结束后再按顺序播出。识别失败或空结果显示“没听清”，不写用户消息、不发起回合；合成失败显示具体失败状态，只停止这条回复的朗读，文字保留，下一条可以恢复。

挂断立即结束本客户端采集与播放，工作会话和主管继续，后续只用文字。手动再次接通延续上下文。自动语音默认关闭；在 Nexus 设置开启后，从下一次真正启动 Harness 开始，每个进程只尝试一次；挂断、刷新和切会话不会重开麦。

## 连续验收级联完整任务

票 06 要求由你本人使用真实 DashScope 识别、合成与当前实际的 Harness 默认模型，亲自完成以下连续流程。受控测试目录中的模型和端点是脚本夹具，不能用作真实验收环境；使用上面无夹具的干净 profile。选择允许修改的测试项目与两个已有普通会话，命名“级联修复”和“级联审查”，准备可重现的错误与测试命令。自动语音保持默认关闭，先配置好真实默认模型和 Host 凭据。

1. 接通 Nexus，点“开始录音”，说：“让已有的级联修复会话解决这个报错，完成后交给级联审查会话独立审查。项目是……，报错是……，测试命令是……。”点“结束录音”。核对识别文字、原生结构化派活工具结果、目标会话实际开始执行，并听到朗读确认。
2. 朗读时点“开始录音”，确认声音立即停下，说一个可核对的新要求，例如“保留原接口，但错误提示改成中文，也让审查检查这一点”，再结束录音。确认插话文字与目标工作会话的原生引导；已经派出的工作继续，主管不会把尚未播出的句子说成你已听完。
3. 挂断，回 Nexus 主会话用文字说：“按刚才的新要求继续，最后报告修改和测试结果。”确认修复和另一个会话的审查继续，结果自动进入原主会话；后续没有声音。
4. 核对实际修改与测试、审查结果和 Nexus 最终汇报一致。它是否追加修复或再次审查由模型判断，不要求固定循环。若失败或阻塞，应说明实际原因。
5. 用文字要求“清理级联修复会话”。核对 Nexus 使用原生归档工具、会话进入归档状态、活动停止，仍可在原生归档列表恢复。清理不删除数据，不让工作会话自行删除日志。

反馈只需说明这一整条“通过”，或指出失败步骤、默认提供方/型号/思考强度、会话标题与可见错误；不要发送密钥、带 token 的 URL 或完整私聊记录。只有你的反馈能作为实机结果；当前自动检查覆盖受控传输与真实原生工具执行，不能代替模型自主决定或物理设备验收。

## 故障处理

| 看到的情况 | 下一步 |
| --- | --- |
| `CREDENTIAL_MISSING` 或鉴权失败 | 检查当前 Host 的凭据引用、key 所属地域与端点；失败输入仍保留。 |
| 麦克风权限被拒、没有设备、设备不可用 | 检查权限、硬件开关与系统设备；先用其它录音软件确认有输入，再手动接通。 |
| 显示已接通但双方无声 | 核对麦克风开关、输入和输出设备，先确认其它软件能录到声音。 |
| 音频播放未就绪 | 先点击页面再手动接通，检查浏览器播放限制。 |
| 级联“没听清” | 本次没有发起对话。检查输入设备、识别端点、型号与 Host 凭据后再录一次；文字仍可用。 |
| 级联“语音合成失败” | 这条回复的文字仍完整保留，通话保持；检查合成端点、音色与 Host 凭据，下一条可重试。 |
| `CALL_BUSY` | 在占用通话的页面挂断或关闭该页面，再在需要的页面接通。 |
| 模型断线或超时 | 根据实际失败重试；任务事实保留，挂断后保持文字，不承诺永久连接。 |
| 主管承诺派活但工作会话没有消息 | 当前模型有这种已知限制；查看实际工具结果/会话，明确要求它查询目标并实际发送，不把承诺记成成功。 |
| 压力超过预算却没有自动摘要 | 设置立即生效，无需重启；近期内容按完整消息保留、可压缩的旧历史不足时会跳过。历史轮数多不等于当前有效上下文长。 |

详细验证范围、打包文件清单、受控/真实证据与待用户实机项见[票 06 验证记录](cascade-voice/verification/06-cascade-lifecycle-and-install.md)。首版 Realtime 组合历史见[票 11 验证记录](nexus-v1/verification/11-clean-install-and-full-scenario.md)。
