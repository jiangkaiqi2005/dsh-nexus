# Harness 启动后自动进入 Nexus 语音

核查日期：2026-10-08。以下是一手文档与当前官方源码事实，未在用户设备实机验收。

## 启动时点

Desktop 先加载打包页面，收到 boot injections 后才激活客户端插件。自动接通应在 Nexus 客户端挂载并且 Host 就绪后尝试；Host 进程本身启动不代表已经有采集麦克风的客户端。[官方架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#desktop-application)

## Web 与 Desktop

浏览器 getUserMedia 首次使用麦克风必须取得许可；有效持续授权后，没有通用的每次点击要求。localhost 与 127.0.0.1 是可信上下文。音频自动播放仍有独立条件；Chrome 官方也说明活跃采集期间允许 autoplay。实现需检查真实采集与播放状态，不以请求已发送当作通话已经成功。[MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)、[安全上下文](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)、[Chrome 自动播放](https://developer.chrome.com/blog/autoplay/)、[活跃采集例外](https://developer.chrome.com/blog/web-audio-autoplay/)

DSH Desktop 当前只允许主 dsh-app://app frame 请求音频；非 macOS 平台的应用回调允许，macOS 检查或请求系统授权。主窗口未覆盖 autoplayPolicy，而 Electron 文档默认无需用户手势。Desktop 自动接通路径较直接，仍需确认系统权限和设备状态。[DSH 麦克风权限](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/src/microphone-permissions.ts)、[窗口配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/src/main.ts#L192)、[Electron 默认](https://github.com/electron/electron/blob/main/docs/api/structures/web-preferences.md)

## 客户端生命周期

麦克风由客户端 renderer 采集，Host 不会自动继承客户端的麦克风。Desktop 隐藏窗口会保留页面与 Host；真正关闭 Web tab 后没有该浏览器采集主体。[Desktop 生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md#closing-the-window-and-quitting)

## 已确认的启动规则

用户已确认：选项默认关闭；开启后，每次 Harness 进程启动自动尝试接通一次；主动挂断后保持文字模式，刷新页面或切换会话不重新开麦，用户可以手动再次接通。是否已尝试自动接通须由 Host 启动周期记录，不能靠页面挂载次数判断。

首次系统权限请求或设备失败不能算作通话成功；客户端应显示实际状态。多个客户端不能同时成为同一主管的音频采集与播放端，具体连接归属需实现验证。
