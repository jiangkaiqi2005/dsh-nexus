# 04：Realtime 模式输入框的模型显示验证

实施基点：`fd4b460`（调研）→ `214c0ec`（补充裁定后实施）。实施与自验由本票实施代理完成，独立 code-review 由协调者安排。本记录不代表评审或用户实机验收通过。

## 经过

1. 按裁定 8 调研后停在「需人工关注」（`ab6c3a6`）：0.2.1-rc.2 的公开 API 做不到「只让 Nexus 认得 Realtime 模型、别的会话看不到」。证据见下文「显示名依赖什么」「逐项排查的公开注册方式」。
2. 协调者经用户授权选了候选方案 1，写入 Spec 裁定 8 的补充裁定（`0f11a58`、`214c0ec`）：接受新版原生回退「请选择模型」。不注册 provider，不加标签，不覆盖选择器，`client.js` 和 `src/` 不改。测试锁定这个回退，并断言普通会话的模型列表里没有 Realtime 模型。向上游提需求的草稿由用户决定是否发出。

## 实施范围

只改 `tests/ui.test.mjs`「Nexus footer opens an enabled native composer and sends to the fixed supervisor」：

- **R8 回退断言**：原来的 `assert.match(<模型按钮文字>, /qwen3\.8-omni-flash-realtime/)` 改成 `assert.equal(<模型按钮文字>, '请选择模型')`。期望值改动对应 R8 和补充裁定。其余断言都没动，包括持久化记录里 assistant 消息的 `source.model === 'qwen3.8-omni-flash-realtime'`（这条证明实际用的是 Realtime 模型）。
- **普通会话模型列表断言**：测试自带的 Host 探针 `nexus-ui-probe` 多注入 `llm`，用 `ctx.llm.registerAdapter(['nexus-ui-worker'], …)` 注册一个夹具模型「UI worker model」。这样做是因为隔离环境里没有凭据时模型目录为空，菜单只显示「暂无可用模型」，「没有 Realtime 模型」的断言就成了空成立；加上夹具模型后，目录里确实有一个模型。Nexus 轮次的断言跑完后，测试点「新建会话」，等侧栏里「新会话」被选中，再点它输入框的模型按钮，等「模型与推理等级」菜单里出现「UI worker model」，然后断言菜单文字不匹配 `/dashscope-realtime|qwen3\.8-omni-flash-realtime/`。观测点选的是用户在普通会话里实际看到的模型下拉。
- 级联模式那边没有任何测试断言模型按钮的文字（`grep 选择模型 tests/` 只在 ui.test 里命中），所以没有要保持不变的断言，也没有改动。

**灵敏度验证**（只在 worktree 里临时改，已还原）：在探针里另外以 provider `dashscope-realtime` 广告 `qwen3.8-omni-flash-realtime`，模拟「Realtime 模型进了目录」。

- 第一次运行：回退断言失败，按钮显示 `'qwen3.8-omni-flash-realtime'`（`ui-leak-sensitivity.log`）。
- 再临时去掉回退断言，普通会话断言失败，报 `a work session must not list the Nexus Realtime model`（`ui-leak-sensitivity-2.log`）。

两条新断言都能抓到泄露。

## 显示名依赖什么

- Nexus 在 Realtime 模式下给主会话写入 `model/selection` `{ provider: 'dashscope-realtime', model: 'qwen3.8-omni-flash-realtime' }`（`src/supervisor.ts:87` 的 `options`、`src/index.ts:74`）。Nexus 没有往 `ctx.llm` 注册 `dashscope-realtime`，所以这个 provider 不在模型目录里。
- 旧版 `@deepseek-ai/dsh-client-ui-model-selection@0.2.0-rc.2`（`npm pack` 到 scratch 空目录只读对照）`lib/client.js:812`：当前选择不在目录时显示 `` `${state.current.provider}/${state.current.model}` ``。
- 新版 0.2.1-rc.2 `lib/client.js:1202` 只在目录里查找当前选择（`currentChoice`），`:1458` 查不到就显示 `t("trigger.fallback")`，即「请选择模型」；`:1460` 无障碍名同理。`conversation.input.model.label` 插槽（`:1464-1473`，只在 `:1517` 的 `currentChoice !== undefined` 分支调用）只用于目录里已有的模型，查不到时不会渲染。
- 目录只有一份，所有会话共用：`ModelCatalogDirectory`（`lib/client.js:713`，注释为 "One Host-generation model catalog shared by every Session selector"）调用 `remote.session.modelCatalog()`（`:752`）。每个会话的 `ModelDirectory.syncInputs()`（`:946-980`）把这份目录的 `groups` 原样放进自己的 store，没有按会话过滤。
- Host 侧 `@deepseek-ai/dsh-api-session-controller/lib/index.js:563` 的 `buildModelCatalog(ctx)` 遍历 `ctx.llm.listProviders()` 和每个 provider 的 `listModels(provider.id)`，只去掉空分组（`:604`），不接收会话参数。`@deepseek-ai/dsh-llm` 的 `listProviders()` / `listModels(provider)`（`lib/types/index.d.ts:281`、`:367`）和 `LlmModelInfo`（`lib/types/types.d.ts:321`）都没有隐藏、仅限某会话或不可选之类的字段。
- 按钮没有禁用：Realtime 模式下用户仍可点开它，选目录里的模型。这是原生行为，本票不处理。

## 逐项排查的公开注册方式

| 途径 | 公开 API | 结论 |
| --- | --- | --- |
| Host 注册 LLM provider/模型（`ctx.llm.registerAdapter`，`listModels` 返回 Realtime 模型） | 是 | 目录不区分会话，模型会出现在所有会话的输入框模型菜单和 `/model` 弹窗里，而且能选中；普通会话选中后，原生 Agent 会把请求发给一个只为 Nexus 语音设计的 provider。违反裁定 8。 |
| 覆盖 `conversation.input.model` 插槽 | 是（插槽目录标注 `replaceRisk: "shadows-shipped-ui"`） | 这是 `kind: 'single'` 插槽，不能按会话注册（`registerOptions: []`）。渲染器对每个会话都只取 `host.entriesOfSlot(slotKey)[0]` 这一个胜者（`dsh-client-ui-renderer/lib/client.js:1174`），Nexus 的条目会替换掉**所有**会话的原生选择器。原生 `ModelSelect` 没有导出（包只导出 `ModelDirectory`、`ModelDirectoryResolver`、`apply`、`inject`，`lib/client.js:1927-1930`），非 Nexus 会话无法把渲染交还给原生组件。 |
| `conversation.input.model.label` 插槽 | 是 | 只在当前选择已在目录里时才渲染。 |
| 改写 `modelDirectories.directoryFor('nexus-supervisor').store`，或改 `model` 命名空间的 `trigger.fallback` 文案 | 能访问到，但这是在改别的插件的内部状态或全局文案 | store 会被 `syncInputs()` 覆盖回去，改文案会影响所有会话。都属于 hack。 |
| 在 Nexus 自己的 list 插槽里按 `sessionId` 只给主会话显示模型名 | 是 | 不会泄露到别的会话，但原生按钮仍显示「请选择模型」，而且改了输入框视觉。 |

## 给上游 Harness 的需求说明（草稿，未发出）

> 是否发出、发到哪里由用户决定。下面是草稿正文。

**标题：** 模型选择器：当前会话的模型不在全局目录时，显示其 `provider/model`，或提供按会话的目录项/标签

**背景：** 我们的插件（dsh-nexus）给一个会话使用插件自有的模型路由（例如 `dashscope-realtime / qwen3.8-omni-flash-realtime`）。这个路由只服务该会话，不应该让其他会话选到，所以没有注册进 `ctx.llm`，也就不在 `session.modelCatalog()` 里。会话历史里的 `model/selection` 是准确的。

**0.2.0-rc.2 → 0.2.1-rc.2 的行为变化：**

- 0.2.0-rc.2 `@deepseek-ai/dsh-client-ui-model-selection/lib/client.js:812`：当前选择不在目录时，触发按钮显示 `${provider}/${model}`。
- 0.2.1-rc.2 同文件 `:1202` 只在目录里查找当前选择，`:1458` 查不到时显示 `trigger.fallback`（「请选择模型」/ "Select model"），无障碍名也变成「请选择模型」（`:1460`）。用户看到的是「还没选模型」，实际上会话正在用一个明确的模型。
- `conversation.input.model.label`（`:1464-1473`）只在当前选择属于目录时渲染，插件无法给目录外的当前选择提供名字。

**为什么插件侧没有干净的做法：**

- 目录全局共享：客户端 `ModelCatalogDirectory`（`:713`、`:752`）和 Host `buildModelCatalog`（`dsh-api-session-controller/lib/index.js:563-611`）都不接收会话参数，`LlmModelInfo` 没有隐藏或按会话可见的字段。注册进目录就等于让所有会话都能选。
- `conversation.input.model` 是全局 `single` 插槽（`dsh-client-ui-renderer/lib/client.js:1174` 每个会话取同一个胜者），原生 `ModelSelect` 没有导出，插件不能只替换某一个会话的选择器。

**希望的改动（任选其一）：**

1. 恢复 0.2.0 的回退：`state.current` 非空但不在目录时，触发按钮和无障碍名显示 `${provider}/${model}`（或带「不可用」标记的同样文字），菜单里不新增可选项。
2. 当前选择不可路由时，也用一个合成的 `{ provider: { id, name: id }, model: { id, name: id } }` 渲染 `conversation.input.model.label`，让插件按 `sessionId` 提供显示名。
3. 提供按会话的模型目录贡献，例如 Host 侧给模型加 `visibility: { sessions: [...] }`，或者客户端提供 per-session 的 directory 扩展点，让某个模型只出现在指定会话里。

**影响：** 任何给特定会话使用插件私有模型路由的插件，在 0.2.1 下都会显示误导性的「请选择模型」。

## 实际命令与结果

全部在干净 worktree 中运行，避开仓库根目录未跟踪的 `promo/` 被 `dsh-workspace-changes` 整树快照拖慢（见票 01 验证记录）。日志在 `.scratch/harness-0.2.1/04/`。

| 命令 | 实际结果 |
| --- | --- |
| 调研：`git worktree add E:/Agent/nexus-wt-04 fd4b460`，`npm ci --ignore-scripts`，`npm run build`，`node --test --test-concurrency=1 tests/ui.test.mjs` | 1 项失败，`'请选择模型'` 不匹配 `/qwen3\.8-omni-flash-realtime/`（`ui-red.log`） |
| `npm pack @deepseek-ai/dsh-client-ui-model-selection@0.2.0-rc.2`（scratch 空目录，只读） | 确认旧版 `lib/client.js:812` 的 `provider/model` 回退 |
| 探查：临时让测试打印 Nexus 会话和新会话的模型菜单 | 两个菜单都只有「暂无可用模型」，所以改为注册夹具模型（`explore-menu.log`） |
| 实施：`git worktree add E:/Agent/nexus-wt-04 214c0ec`，`npm ci --ignore-scripts`，`npm run build`，复制本票 `tests/ui.test.mjs` | 成功 |
| `node --test --test-concurrency=1 tests/ui.test.mjs`，2 次 | 2/2 通过，各约 5.4s（`ui-green-1.log`、`ui-green-2.log`） |
| 灵敏度：临时以 `dashscope-realtime` 广告 Realtime 模型 | 回退断言失败（`ui-leak-sensitivity.log`）；去掉回退断言后普通会话断言失败（`ui-leak-sensitivity-2.log`） |
| `npm run typecheck`（worktree 与仓库目录） | 都通过，0 错误（`wt-typecheck.log`、`repo-typecheck.log`） |
| `npm test` 全套（worktree，后台） | 146 项：131 通过、0 失败、15 跳过，23 分 8 秒，退出码 0（`wt-full.log`）。15 项跳过都是 opt-in：`NEXUS_DESKTOP_SMOKE` 的 3 项和真实模型/语音的 12 项。profile 组 13 项全部通过，这次没有出现 Host 提前退出 |
| `NEXUS_DESKTOP_SMOKE=1 node --test --test-concurrency=1 tests/desktop.test.mjs tests/cascade-install.test.mjs tests/clean-install.test.mjs`（worktree） | 3/3 通过，50 秒（`wt-smoke.log`）；用 `D:/DeepSeekHarness` 自带的 0.2.1-rc.2 CLI 和隔离 `DSH_HOME` 安装打包产物 |
| `git worktree remove --force` | 两次都报 "Filename too long"，改用 `rm -rf` 加 `git worktree prune` 清理 |

全部运行都使用隔离的 `DSH_HOME`，没有读写用户的 `~/.dsh`，也没有安装到用户的 `desktop` profile。
