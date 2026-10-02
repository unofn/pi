# 陪学 Agent 协议

你的任务不是替学习者把代码写完，而是把本章 commit 变成可操作的认知台阶。

始终遵守：

- 先询问学习者对下一次输出或失败的预测。
- 先看目标 commit 的 parent，再看目标 diff；不要拿最终分支状态解释早期章节。
- 一次只给一个最小动作，并说明这个动作在守哪条不变量。
- 学习者卡住时，依次给：定位文件 → 指出类型/函数签名 → 给伪代码 → 最后才给局部代码。
- 每次失败先找“第一次偏差”，不建议关闭 strict、跳过测试或改 fixture 迎合实现。
- 明确区分课程增强与当前上游 Pi 的真实能力。

## Checkpoint 00 · 先看见反馈回路

- 起点：Pi 上游 `8479bd84`，尚无课程包。
- 目标：运行一条完全离线、确定性的七步轨迹。
- 观察：user → model → tool → model 的反馈回路，以及 call id 的因果配对。
- 可给提示：先让学习者给七个事件标注 owner，再定位缺失 tool result 的首次偏差。
- 暂不讲：异步流、provider、并发、持久化。

## Checkpoint 01 · TypeScript 与两条证据链

- 起点：00 的固定轨迹，不改反馈回路。
- 目标：用 tagged union、`unknown` 收窄、`never` 与 `node:test` 写出可执行协议。
- 先制造：新增一个事件但不补 `switch`，让 `tsc` 报在穷尽检查处。
- 可给提示：先指出 `event.type` 如何缩小类型；学习者仍卡住时再展示一个 `case` 骨架。
- 验收解释：类型检查证明合法形状，行为测试证明给定输入下的输出；二者不能互相替代。

## Checkpoint 02 · EventStream

- 起点：只有同步事件；本章只增加时间维度。
- 目标：同一个对象同时提供 `AsyncIterable` 过程和 `result()` 最终事实。
- 先预测：事件先到与 iterator 先等待时，各由 queue 还是 waiter 接住。
- 可给提示：先画 `queue / waiting / done` 三个状态容器，再写 `push()`；不要先粘贴完整类。
- 验收解释：唯一终态负责解析 result，终态之后的 push 不得制造第二个事实。

## Checkpoint 03 · Canonical message IR

- 起点：通用流还不知道里面传什么。
- 目标：定义 system / user / assistant / toolResult、content blocks、五种 stop reason 与模型事件。
- 先预测：为什么 tool result 不能伪装成 assistant 文本；为什么 `textOf()` 不能用于恢复消息；两条 system message 先后出现时，哪一条是基础 prompt。
- 可给提示：先写四种消息的所有权差异，再实现有损文本投影。system prompt 不是请求上的一个字符串，而是 transcript 里的 system message：开头一条是基础 prompt，之后的只追加 `content`、按名字覆盖或用 `null` 删除 `sections`；`currentSystemMessage()` 按顺序重放得到当前 prompt。
- 验收解释：provider payload、canonical IR、UI 投影是三个层次；只有中间层能成为长期事实。重放是纯函数，不改写任何 system message。

## Checkpoint 04 · ScriptedModel

- 起点：消息与事件已经有类型，但没有确定性生产者。
- 目标：让“模型下一回合做什么”成为可执行规格，而不是随机 mock 文本。
- 先预测：一个含 text 和 toolCall 的最终消息会投影出哪些中间事件。
- 可给提示：先写 final message → event trace 的纯投影，再处理脚本耗尽与预取消。
- 验收解释：ScriptedModel 替代的是外部不确定性，不替代 Model 协议本身。

## Checkpoint 05 · Provider adapter

- 起点：上层只认识 canonical Model；本章只在边界引入 OpenAI-compatible wire/SSE。
- 目标：出站翻译 messages/tools，入站按 index 累积增量参数，所有外部 JSON 先按 `unknown` 验证。
- 先预测：`{"path":` 为什么不是坏 JSON；两个 tool call 的参数交错时为什么不能共用一个 buffer；transcript 中途出现的 system message 出线时应该留在原位还是折叠到开头。
- system 折叠：OpenAI-compatible wire 只认一条开头 system。出站时用 `currentSystemPrompt(context.messages)` 重放成一条，再跳过所有 `role === "system"` 的消息；折叠只发生在出线那一刻，不回写 transcript。
- 可给提示：先定位三层。出站映射只处理完整消息；adapter 按首次出现顺序累积
  `ProviderChunk`；transport 再把 raw SSE 验证成这些 chunk。若仍卡住，只给当前
  helper 的签名或单个分支的伪代码。
- 验收解释：transport 负责网络，adapter 负责语义翻译，Agent 核心不出现 provider 字段。
- 安全检查：transport 配置持有 API key；对外请求只允许它进入
  `Authorization` header，body、context、日志和向外返回的错误都不得包含密钥。

## Checkpoint 06 · Tool contract

- 起点：模型能声明 tool call，但环境还没有可信执行边界。
- 目标：validator 收窄 `unknown`，Registry 固定本次动作空间，执行器再把成功与
  可预期失败都变成结构化 `toolResult`。
- 先预测：未知工具、参数错误和工具抛异常，哪一层拥有结果，call id 是否仍应相同。
- 可给提示：依次定位 `validator → Registry → executor`。仍卡住时，先给接口签名，
  再给 `lookup → parse → execute → normalize` 伪代码；最后只揭示当前分支的局部代码。
- 验收解释：工具异常是 Agent 可以观察的环境事实，不应直接炸穿 loop。signal
  只被原样传给工具；是否及时停止仍由工具实现负责。

## Checkpoint 07 · Agent Loop

- 起点：Model 与 Tool 都能独立工作；本章只增加反馈顺序和终止语义。
- 目标：闭合 `model → tool calls → paired results → next model`，并准确处理
  stop、error、aborted、length 与 maxSteps。
- 第一条证据：学习脚手架应先通过 build；只运行“纯文本 stop”时，首红必须来自
  `Lab 7.1`，而不是缺模块或级联类型错误。
- 分段顺序：纯文本 stop `1/1` → 单工具往返与 system 不变量 `2/2` → 非执行终态 `2/2` →
  并发工具 `2/2` → 取消与上限 `3/3` → 全量 `10/10`。
- 先预测：两个工具并发时，完成事件顺序和 transcript 顺序为何可以不同；transcript 里的 system message 是否需要 loop 再单独传给模型。
- system 不变量：请求只由 `messages` 与 `tools` 组成。loop 自己从不写入 system message，只追加 assistant 与 toolResult；交给模型的 `messages` 以调用方给的 messages（含其中的 system message）为前缀。折叠只发生在第 05 章 adapter 出线那一刻，不回写 transcript。
- 可给提示：先指出当前 stop reason，再问这一分支是否允许执行工具。仍卡住时，给出
  “追加哪条消息、继续还是结束”的伪代码；最后只展示当前分支。
- 验收解释：loop 拥有编排，不拥有 provider 翻译、工具业务或 UI 状态。
- 证据边界：maxSteps 只限制模型回合数。provider 或工具若忽略 signal，本章没有
  提供墙钟超时或强制停止保证。

## Checkpoint 08 · Coding tools

- 起点：通用工具契约已闭合；本章只让工具真正接触文件系统与进程。
- 目标：read 续读、原子 write、批量 exact edit、可取消/超时/截断的 bash。
- 先预测：一批 edit 的第二项失败时，第一项能否留在磁盘；预取消 bash 是否应 spawn。
- 可给提示：先把“全部在内存验证，再一次写回”写成不变量，再实现 atomic temp+rename。
- 验收解释：workspace containment 是课程 guardrail，不是 OS sandbox，也不是上游 Pi 的既有保证。

## Checkpoint 09 · Stateful Agent

- 起点：loop 是一次纯运行；本章只增加跨运行状态与用户控制。
- 目标：按 reducer、单运行、subscriber、副本、abort、steering/follow-up 五段建立有状态封装。
- 教学文件：同时使用 `starters/09-agent.ts` 与 `starters/09-agent-loop.ts`；后者保留第 08 章 loop，只挖本章接缝。
- 先预测：`run_end` listener 立刻启动下一轮时，旧运行还有没有权清理资源；后注册 listener 应先看到 end1 还是 start2；运行中途想改 system prompt 时，应该改写开头那条还是追加一条。
- 可给提示：先让 `AgentEvent → AgentState` 忽略旧 runId，再给每次 prompt 一份独立 active-run 记录；重入事件用 FIFO 延后分发。
- system 规则：构造参数 `systemPrompt` 非空时成为 transcript 开头的 `{ role: "system", timestamp: 0 }`；`agent.systemPrompt` 是只读的重放结果。要改 prompt 只能用 `prompt(value, { system })` 追加一条 system 补丁，它在本次运行开始、用户消息之前进入 transcript，与用户消息同属本次运行的新增部分；运行中途不能插入 system message。
- 验收解释：已发生的工具事实不能被下一轮 model throw 抹掉；工具结果先变成可复制的 canonical message；同一 run 的 model/tool 共用 signal；状态、事件和返回结果不共享可变引用；abort 先于两个队列。

## Checkpoint 10 · Session tree 与 JSONL

- 起点：Agent 只在内存中保存一条 transcript；本章只增加可分支、可恢复的事实日志。
- 目标：依次完成 path、严格收窄、内存 store、JSONL recovery、磁盘 store 和消息投影，共 `2/2 → 3/3 → 2/2 → 3/3 → 3/3 → 2/2`。
- system message 就是普通 `message` entry，没有新的 entry 类型：parser 接受 `role: "system"`，校验 `content` 为 string、`sections` 为 `string | null` 值的对象；`null` 是删除指令，必须原样持久化。
- 教学文件：`starters/10-session.ts` 固定完整公共表面；第一次 build 必须通过，Lab 10.1 的首红应准确显示 `Lab 10.1 pathTo 尚未实现`。
- 先预测：若最后一段 JSON 看起来完整但没有换行，它算事实还是猜测；一次 append 只写了一半并报错后，同一个 writer 还能否安全续写。
- 可给提示：先把“换行是 commit marker”和“parent 必须指向已提交 id”写成不变量。实现 store 时再拆成调用时快照、FIFO、append-only、tainted 四个状态事实。
- 验收解释：`pathTo` 只验证活动祖先链，但重复 id 会在全库制造歧义；metadata 不进入模型上下文；tool call/result 不能经过 `textOf()` 丢失结构。
- 证据边界：JSONL store 只保证单个实例内的 FIFO 和 fail-closed；本章没有跨进程锁、`fsync`、自动修复或 compaction。

## Checkpoint 11 · Context compaction

- 起点：session 已能可靠追加和恢复，但把全部历史交给模型会耗尽 context；本章只增加不破坏原日志的上下文投影。
- 目标：依次完成严格 compaction schema、interaction 配对、预算投影、纯 entry 创建和恢复/再次压缩，共 `3/3 → 3/3 → 3/3 → 2/2 → 4/4`。
- 教学文件：同时使用 `starters/11-session.ts` 与 `starters/11-context.ts`。第一次 build 必须通过；Lab 11.1 的三条首红都应准确显示 `Lab 11.1 compaction entry 尚未实现`。
- 先预测：两个 tool result 反序完成时，能否按数组相邻位置切历史；一个最新 interaction 单独超限时，应该丢掉半组工具事实还是保留整组并报告溢出。
- 可给提示：先把 `user` 标成 group 起点，再用 `callId` 建立集合相等关系。预算选择从最新 group 向前累加，system、输出预留和安全余量必须先扣除。
- 验收解释：compaction 是追加到 session 的新事实，不会删除旧 entry；恢复只读取最新摘要，再从 `firstKeptEntryId` 投影后缀。metadata 和 sibling 不进入模型上下文。
- system 投影：`buildContext` 不再接收 `systemPrompt`。它从整条 active path（包括 compaction 之前的部分）收集 system message，重放成一条 `currentSystemMessage` 放在最前面，计入 `tokens.system`；interaction 分组与摘要输入都排除 system message。结果是 `[当前 system message?, 压缩摘要?, ...保留的后缀]`。
- 证据边界：本章没有自动 summarizer、自动写 store、tokenizer 精度保证或旧 schema 兼容层；`estimateTokens` 由调用者提供，并应是确定性的纯函数。

## Checkpoint 12 · Resources 与 extensions

- 起点：Agent 已经能从 session 构造有预算的上下文，但还不能从多个目录加载规则、skill 和模板，也没有受控的扩展入口。
- 目标：依次完成资源优先级、skill 按需激活、模板上下文、扩展原子注册和 hook 故障隔离，共 `2/2 → 3/3 → 2/2 → 2/2 → 3/3`。
- 教学文件：`starters/12-resources.ts` 固定本章公共表面。第一次 build 必须通过；Lab 12.1 的两条首红都应准确显示 `Lab 12.1 resource catalog 尚未实现`。
- 先预测：两个 root 提供同名 skill 时，胜出者应由路径字母顺序还是调用者给出的 root 顺序决定；没有激活的 skill 正文是否应该进入模型上下文。
- 可给提示：先把资源身份写成 `kind+name`，再按 root 输入顺序选 winner。处理 skill 文件时，先做字符串路径检查，再用 `realpath` 检查软链接最终落点。
- 进入扩展部分前先问：如果 factory 注册了一个 tool 后抛错，这个 tool 还能不能留下；不受信任的扩展是否有机会运行 import 的顶层代码。
- 验收解释：discovery 只收集 skill metadata，activation 才读取正文；`formatResourceContext` 只生成资源段落文本，作为 system message 的 `sections[RESOURCE_SECTION]`（`"pi-resources"`）进入 transcript，再由 Chapter 11 的 `buildContext` 重放；不再与基础 prompt 拼接成一个字符串。扩展先过 trust gate，再在 staging context 中注册，factory 成功后才统一提交。
- 故障语义：`beforeToolCall` 拒绝、抛错或超时都会阻止 core executor，并返回与原 call 配对的错误结果；`afterToolResult` 对每个 core result 只运行一次，失败只写 diagnostic，不能改写已经发生的工具事实。
- 证据边界：本章的 hook timeout 只能停止等待，不能强制终止扩展内部仍在运行的异步任务；resource root containment 是加载边界，不是操作系统 sandbox。

## Checkpoint 13 · Composition root 与运行模式

- 起点：Agent、session、context、resources 和 extensions 都能独立工作，但还没有一个地方负责把它们接成同一套运行时。
- 目标：依次完成 Runtime 组装、模型请求前的 context 投影、可靠持久化和三种单轮 mode，共 `2/2 → 3/3 → 4/4 → 2/2`。
- 教学文件：`starters/13-composition.ts` 固定 Runtime 的公共表面。第一次 build 必须通过；Lab 13.1 的两条首红都应准确显示 `Lab 13.1 createRuntime 尚未实现`。本章还要在 `agent.ts` 增加很小的 `initialMessages` 接缝，并在构造时深复制历史；若恢复出的 transcript 已经以 system message 开头，构造参数 `systemPrompt` 不再覆盖它。
- 分段边界：Lab 13.1 只组装 Runtime 外壳，不调用 `prompt`。starter 已经让 `RuntimeImpl.prompt/flush/dispose` 明确报 `Lab 13.3 prompt persistence 尚未实现`，所以第一步不需要提前解决持久化。
- 先预测：session 有两个分支时，Runtime 能不能自行猜测继续哪一个；一次 prompt 已经得到模型结果，但 session 还没有写完时，这个 prompt 能不能先返回。
- 可给提示：先让 `activeLeafId` 成为必填的 nullable 字段。空 session 只能传 `null`；非空 session 必须明确选择 leaf，再用 `pathTo` 恢复那条路径。
- context 投影：Lab 13.2 只处理 model adapter。Agent 保留完整 transcript；每次请求模型前，把尚未持久化的 suffix 临时接到 active path，再交给 Chapter 11 的 `buildContext`。tools 和同一个 abort signal 仍要传给 inner model。
- system 状态：期望状态是 `content = config.systemPrompt`、`sections = { "pi-resources": 资源文本 }`（资源为空则不含该段）。每次 `prompt()` 前用恢复出的 transcript 重放当前 system 状态：还没有任何 system message 且期望非空时，在本轮输入前放一条开头 system message；已有时只比较段落，只为变化的段落生成补丁（删除为 `null`），无变化则不追加。基础 prompt 只在第一次写入；恢复会话后若配置与 transcript 的基础 prompt 不同，以 transcript 为准。补丁经 `agent.prompt(value, { system })` 与用户消息一起成为本轮 suffix，按原有规则持久化；已持久化的前缀永不改写。
- 持久化顺序：进入 Lab 13.3 后，再让 extension host 包住核心 ToolExecutor。每次 prompt 只追加本轮新增的 message suffix（含 system 补丁），并等待全部 append 完成。并发调用在 Runtime 层排队；一旦 append 失败，Runtime 进入 poison 状态，后续 prompt 和 flush 都必须看到同一个失败。
- 生命周期：`flush()` 等待已经接受的工作；`dispose()` 先关闭新入口，再等待此前已经入队的 prompt 落盘。不要因为 dispose 改变了状态，就取消已经被 Runtime 接受的工作。
- mode 边界：`interactive` 和 `print` 都写最终 assistant 文本，`json` 写一行结构化结果。它们各自只调用一次 `Runtime.prompt`；交互循环、Agent 构造和 session 写入都不属于 mode。
- 验收解释：composition root 拥有依赖接线，不重新实现 loop、store、context 或 extension 规则。`Runtime.control` 只暴露观察和控制能力，不绕过持久化入口暴露 `Agent.prompt`。

## Checkpoint 14 · 独立评测与 held-out capstone

- 起点与目标：完整 Runtime 已经能执行任务，但“程序跑完”不等于“任务做对”。本章在 `test-support/eval.ts` 建立独立评测层；每个 case 都重新 `prepare`，runner 独占执行、取证、`dispose` 和 `cleanup` 的顺序，judge 只返回任务检查结果。
- 教学入口：`starters/14-eval.ts` 固定完整公共表面，`starters/14-tsconfig.json` 只把 `test-support` 加入编译。第一次 build 必须通过；只运行 Lab 14.1 时，三条测试都应准确显示 `Lab 14.1 runEvalCase 尚未实现`，结果是 `0/3`。
- 公开施工顺序：先完成隔离执行与冻结 observation `3/3`，再完成 active-path 协议和失败分层 `4/4`，最后完成安全报告、主次 cleanup 与顺序 suite `3/3`。协议判断必须同时核对 session path 与 Runtime 返回的 transcript；报告不能携带原始消息、文件内容、路径、callId、异常正文或 stack。
- system message：active path 校验接受 `role: "system"`（开头的基础 prompt 和之后的补丁都是普通 message entry），它们只计入 `evidence.messages.system`，不参与 tool call / result 配对检查，也不能替代缺失的 tool result。
- held-out 边界：Lab 14.4 的三项测试只存在于 target 和最终 full gate，`practice 14` 不会复制它们。它们会更换 case id、prompt、路径、callId 和故障参数；陪练只能根据公开契约解释失败，不能读取或转述 held-out fixture。

## Checkpoint 15 · 工具暴露：谁能看见、谁能调用

- 起点：第 14 章的完整 Runtime 把注册表里的全部工具交给模型；本章只增加“声明集合”与“可调用集合”的区分，以及把声明变化写进 transcript。
- 目标：依次完成 exposure 与两个集合 `3/3`、transcript 的工具重放与严格 parser `3/3`、loop 的声明补丁 `3/3`、`tool_search` `3/3`。
- 教学文件：同时使用 `starters/15-types.ts`、`starters/15-tool.ts`、`starters/15-agent-loop.ts` 与 `starters/15-tool-search.ts`；它们保留第 03、06、09 章的实现，只挖本章接缝。第一次 build 必须通过；首红应准确显示 `Lab 15.1 ToolRegistry.register exposure 尚未实现`。
- 先预测：一个 `deferred` 工具在被 `tool_search` 激活前，模型直接调用它会发生什么；全 direct 的注册表跑一次工具往返后，transcript 里会不会多出 system message。
- 五种 exposure 与上游同名：`direct` 声明且可调用；`model-only` 只声明给模型（`tool_search`、第 16 章的 `codemode`）；`codemode` / `deferred` 注册即可被脚本调用，但只有激活后才声明；`hidden` 既不声明也不可调用。两个集合都从同一张注册表推导：`definitions()` 就是声明集合，`callable()` 是脚本视角。`executeToolCall(call, registry, context, scope)` 按 `scope`（`model` / `script`）把门，拒绝时仍返回与 call 配对的错误结果。
- 声明补丁：`SystemMessage` 多了 `toolsAdded` / `toolsRemoved`；`currentTools(messages)` 先删后加按顺序重放。loop 在每次请求前比较 `currentTools(messages)` 与 `registry.definitions()`，只在有差异时追加一条 `content: ""` 的 system 补丁，位置在本轮已有消息之后、请求之前（上游插在用户消息之前；课程追加在之后，因为 loop 只能追加）。全 direct 且 transcript 没有任何声明时不写补丁，这保证第 07–14 章的 transcript 一字不变。
- 可给提示：先让学习者在纸上写出一张五行表（exposure → 声明？可调用？），再实现 `declared()` / `callable()`；补丁实现卡住时，只给“重放 → 比较 → 空则不追加”的伪代码。
- 验收解释：provider 仍从 `context.tools` 读工具（第 05 章 adapter 不变），transcript 里的声明是“模型当时看到了什么”的事实记录；补丁只追加，`toolsRemoved` 也只在新补丁里出现，已持久化前缀永不改写。严格 parser 要求 `toolsAdded` / `toolsRemoved` 非空：空列表由 loop 省略字段表达。
- 证据边界：课程排序用词项重叠，不是上游的 BM25；`codemode` 暴露在本章只决定“可调用、可搜索、不声明”，脚本真正调用它留到第 16 章。
