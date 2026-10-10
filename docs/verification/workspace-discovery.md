# 已登记项目发现与跨目录派活

验证日期：2026-10-10。unitBase：`c98d920810827630e43fa64687e8a3ff9130f53c`。范围是侧栏已登记项目的新普通会话派活，关联 Spec 用户故事 7–14 和票 03；票 07–11 未改动。

## 修复与公开契约

现有主管只有会话列表和创建工具，没有原生项目查询。主管从其启动目录用 glob 搜目录名不能取得侧栏登记的显示名称与路径，也不能据此在正确项目派活。

增加只读 `nexus_list_workspaces`，直接调用当前官方 `@deepseek-ai/dsh-workspace@0.2.0-rc.2` 的 `ctx.workspaceRegistry.list()`，返回 `items: [{ id, title, path }]`。公开类型位于发布包 `lib/types/index.d.ts` 的 `list(): Workspace[]` 与 `lib/types/types.d.ts` 的 `Workspace`；稳定身份、显示名称和规范化绝对路径均来自原生服务。每次调用重新读取，不按主管 cwd 筛选、不按会话数量筛选、不解析存储、不扫描磁盘、不暴露 subagent 成员、不新增依赖。查询异常进入现有原生工具失败回填，不冒充空列表。

文字与语音共用主管指引：指定项目时先查官方列表，用返回路径调用已有 `nexus_create_session`；已有普通会话仍用 `nexus_send_session`。不能用 glob 或 web_search 猜本地目录，未知或歧义名称先问用户，明确绝对目录仍沿用已有创建语义。名称选择由主管模型判断，Host 不增加名称分类器或固定流程。

## 红绿与真实 Host 证据

`tests/workspace.test.mjs` 通过真实官方 dsh profile 加载本插件；模型端点是本机受控 Realtime WebSocket。主管启动在 `supervisor` 目录，目标目录为 `folder-with-unrelated-name`，官方登记显示名最初为“侧栏登记项目”，随后用原生 `setTitle` 改为“dsh-nexus”。另登记从未建立会话的“空白项目”。

- 修复前 `node --test tests/workspace.test.mjs`：1 failed、0 passed。文字/语音 schema 缺少查询工具，断言 `project query is available in text and voice` 为 false；原生查询调用失败，未创建 worker。日志 `.scratch/nexus-v1/workspace-discovery/red.txt`，报告 `.scratch/nexus-v1/workspace-discovery-JDuvlL/{result,wire}.json`。
- 修复后同一命令：1 passed、0 failed，6.648 秒。日志 `.scratch/nexus-v1/workspace-discovery/green.txt`，报告 `.scratch/nexus-v1/workspace-discovery-9ZWfSU/{result,wire}.json`。
- 查询前后原生工作区身份、名称、路径、时间戳、成员以及会话身份/归属一致；主管自身的原生工具记录正常增加。下一次查询得到改后的名称。空白登记项目在列表中且最后仍无会话、无文件。
- 受控模型从真实查询结果中选出“dsh-nexus”的返回路径，调用已有创建能力。默认原生 worker 工厂实际运行受控 LlmAdapter；原生 header.cwd 为目标目录，origin/parentSession 均无 subagent 值，目标工作区的公开 sessionIds 包含新会话。原生用户消息保持 Nexus 调度来源，任务文本为 `run-workspace-discovery`；worker 在其真实 cwd 写出 `workspace-task.txt`，原生助手记录实际执行文字，turn/end 为 completed。收据 accepted 不作为完成证据。
- 真正打开主管语音模型连接，确认语音 schema 也包含查询工具与共用项目指引；未输入语音或模拟物理麦克风。对外部 registry 服务做受控异常注入，模型收到 `Workspace registry fixture failure` 的原生 isError 结果，没有假空列表。
- 实施中的一次 fixture 使用历史用户目标响应自动工作结果，导致重复创建，已改为仅消费最近助手之后的新用户目标；另一次受控 worker 误取原生技能提醒，已限定读取实际测试任务。两者是测试端点问题，不作为产品通过证据。首次红测报告落盘时序未捕获目标断言，也不计作缺陷红证据。

相关回归 `node --test tests/workspace.test.mjs tests/dispatch.test.mjs`：2 passed、0 failed、1 skipped（原有付费模型 opt-in），17.769 秒；`.scratch/nexus-v1/workspace-discovery/focused.txt`。保留已有普通会话、来源、引导、停止、失败续答与拒绝管理 subagent 的检查。

## 官方 Desktop 隔离打包冒烟

构建后运行 `$env:NEXUS_DESKTOP_SMOKE='1'; node --test tests/desktop.test.mjs`：1 passed、0 failed，16.171 秒；`.scratch/nexus-v1/workspace-discovery/desktop.txt` 与 `.scratch/nexus-v1/desktop-smoke-qkG9jn/result.json`。

现有冒烟通过官方 Desktop 自带 `D:/DeepSeekHarness/resources/runtime/cli/bin/dsh.cmd`，在真正空的隔离 DSH_HOME 中由 `plugin add` 初始化 profile、设置官方 pnpm peer 行为、安装当前构建 tgz，再以隐藏 Host `--no-open` 和非持久化无头 Edge 使用原生文字输入。受控模型实际调用安装包中的查询工具，得到原生主管所在工作区的身份/名称/路径，继续文字回应并落盘；第二个进程恢复同一主管完整记录，未重新调用模型。保留安装模块身份、构建 hash、Host scope、原生 journal 与进程清理断言，未手写跳过官方初始化。

## 最终检查与边界

`npm run typecheck`、`npm run build`、`git diff --check` 通过。最终默认 `npm test`：54 项，46 passed、0 failed、8 skipped，131.878 秒，正常退出；日志 `.scratch/nexus-v1/workspace-discovery/full.txt`。跳过的是 7 个原有付费模型 opt-in 与 Desktop opt-in；Desktop 已单独通过。全套中的项目回归证据为 `.scratch/nexus-v1/workspace-discovery-4hSqw2/{result,wire}.json`，11.199 秒。

所有 Host 使用本次独立 DSH_HOME/DSH_AGENTS_HOME、隐藏进程及既有 Windows Job Object 清理。没有操作用户 Desktop/浏览器、安装用户 profile、读用户 journal 或凭据、修改宿主或 Qiyu，也没有调用付费模型。包版本的已有未提交修改不属于本单元提交。

受控 Realtime 验证了模型工具调用链与原生项目/普通会话的实际执行；它没有证明真实模型自然语言名称选择、未知/重名时主动询问、真实语音派活或物理音频。共用指引的模型可见性已自动检查，真实文字/语音选择与用户 Desktop 行为仍由用户验收。
