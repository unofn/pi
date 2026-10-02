import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "../src/agent-loop.js";
import { MAX_OUTPUT_CHARS, MAX_OUTPUT_ITEMS } from "../src/codemode-protocol.js";
import {
  CODEMODE_TOOL_NAME,
  createCodemodeTool,
  createNestedToolBridge,
  runCodemodeScript,
  type CodemodeScriptTool,
  type CodemodeToolDetails,
} from "../src/codemode.js";
import { ScriptedModel } from "../src/scripted-model.js";
import {
  executeToolCall,
  objectSchema,
  stringValue,
  ToolRegistry,
  type Tool,
  type ToolExposure,
} from "../src/tool.js";
import {
  assistantMessage,
  currentTools,
  text,
  userMessage,
  type AgentMessage,
  type ToolCall,
  type ToolResultMessage,
} from "../src/types.js";

const SLOW = { timeout: 10_000 };

function scriptTools(
  entries: Record<string, CodemodeScriptTool["execute"]>,
): Map<string, CodemodeScriptTool> {
  return new Map(
    Object.entries(entries).map(([name, execute]) => [
      name,
      { description: `${name} tool`, execute },
    ]),
  );
}

interface EchoTool extends Tool<{ value: string }> {
  runs: number;
  callIds: string[];
}

function echo(name: string, exposure?: ToolExposure): EchoTool {
  const tool: EchoTool = {
    name,
    description: `${name} returns its value`,
    schema: objectSchema({ value: stringValue }),
    ...(exposure ? { exposure } : {}),
    runs: 0,
    callIds: [],
    async execute({ value }, context) {
      tool.runs += 1;
      tool.callIds.push(context.callId);
      return { content: [text(`${name}:${value}`)], details: { name } };
    },
  };
  return tool;
}

function call(id: string, name: string, args: unknown): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function detailsOf(result: ToolResultMessage): CodemodeToolDetails {
  return result.details as CodemodeToolDetails;
}

test("Lab 16.1 · 脚本在独立 worker 的 QuickJS 里运行：await tools.<name>(args) 经消息桥往返，返回值按 JSON 回到宿主", SLOW, async () => {
  const seen: unknown[] = [];
  const result = await runCodemodeScript(
    `const sum = await tools.add({ a: 2, b: 3 });
     console.log("sum is", sum);
     const names = ALL_TOOLS.map((tool) => tool.name);
     return { doubled: sum * 2, names, kind: typeof tools.add };`,
    {
      tools: scriptTools({
        add: async (args) => {
          seen.push(args);
          const { a, b } = args as { a: number; b: number };
          return a + b;
        },
      }),
    },
  );

  assert.deepEqual(result, {
    ok: true,
    value: { doubled: 10, names: ["add"], kind: "function" },
    output: ["sum is 5"],
    calls: [{ name: "add", status: "ok" }],
  });
  assert.deepEqual(seen, [{ a: 2, b: 3 }]);
  assert.equal(Object.getPrototypeOf(seen[0]), Object.prototype);
});

test("Lab 16.1 · 脚本抛错、语法错误与工具拒绝都变成 ok:false 的结果，不会让宿主抛异常", SLOW, async () => {
  const thrown = await runCodemodeScript(`throw new TypeError("nope");`);
  assert.equal(thrown.ok, false);
  if (!thrown.ok) {
    assert.equal(thrown.error.kind, "script");
    assert.equal(thrown.error.name, "TypeError");
    assert.equal(thrown.error.message, "nope");
    assert.match(thrown.error.stack ?? "", /TypeError: nope/);
  }

  const syntax = await runCodemodeScript(`return (;`);
  assert.equal(syntax.ok, false);
  if (!syntax.ok) {
    assert.equal(syntax.error.kind, "script");
    assert.equal(syntax.error.name, "SyntaxError");
  }

  const tools = scriptTools({
    boom: async () => {
      throw new Error("boom failed");
    },
  });
  const caught = await runCodemodeScript(
    `try { await tools.boom(); return "unreachable"; } catch (error) { return "caught: " + error.message; }`,
    { tools },
  );
  assert.deepEqual(caught, {
    ok: true,
    value: "caught: boom failed",
    output: [],
    calls: [{ name: "boom", status: "error" }],
  });

  const uncaught = await runCodemodeScript(`await tools.boom();`, { tools });
  assert.equal(uncaught.ok, false);
  if (!uncaught.ok) {
    assert.equal(uncaught.error.kind, "script");
    assert.equal(uncaught.error.message, "boom failed");
  }
  assert.deepEqual(uncaught.calls, [{ name: "boom", status: "error" }]);
});

test("Lab 16.1 · 每次执行都是新的 VM：全局变量不跨执行泄漏；内存上限下的失控分配以 out of memory 失败", SLOW, async () => {
  const first = await runCodemodeScript(
    `globalThis.leak = 1; return typeof globalThis.leak;`,
  );
  assert.deepEqual(first, { ok: true, value: "number", output: [], calls: [] });
  const second = await runCodemodeScript(`return typeof globalThis.leak;`);
  assert.deepEqual(second, { ok: true, value: "undefined", output: [], calls: [] });

  const exhausted = await runCodemodeScript(
    `const chunks = []; for (;;) chunks.push(new Array(100_000).fill(1));`,
    { memoryLimitBytes: 16 * 1024 * 1024 },
  );
  assert.equal(exhausted.ok, false);
  if (!exhausted.ok) {
    assert.equal(exhausted.error.kind, "script");
    assert.match(exhausted.error.message, /out of memory/);
  }
});

test("Lab 16.1 · 没有计时器与 I/O：等待永不结算的 promise 立刻以 stalled 失败，而不是挂到超时", SLOW, async () => {
  const started = Date.now();
  const result = await runCodemodeScript(
    `await new Promise(() => {}); return "never";`,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "script");
    assert.match(result.error.message, /can never settle/);
  }
  assert.ok(Date.now() - started < 4_000, "stalled 脚本不应等到 deadline");
});

test("Lab 16.1 · 循环打印超过输出上限时脚本以 RangeError 失败，catch 住也不能继续输出，宿主只保留上限内的输出", SLOW, async () => {
  const large = await runCodemodeScript(
    `const s = "x".repeat(1 << 20); for (;;) { try { console.log(s); } catch {} }`,
  );
  assert.equal(large.ok, false);
  if (!large.ok) {
    assert.equal(large.error.kind, "script");
    assert.equal(large.error.name, "RangeError");
    assert.match(large.error.message, /script output exceeded/);
  }
  const chars = large.output.reduce((sum, text) => sum + text.length, 0);
  assert.ok(chars <= MAX_OUTPUT_CHARS, "宿主保留的字符数不超过上限");
  assert.ok(chars > MAX_OUTPUT_CHARS - (2 << 20), "上限之内的输出照常保留");

  const empty = await runCodemodeScript(`for (;;) console.log("");`);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.error.name, "RangeError");
  assert.equal(empty.output.length, MAX_OUTPUT_ITEMS);
});

test("Lab 16.2 · 嵌套调用走第 06/15 章执行路径：id 为 <parent>/<n>，表里只有可调用集合，不存在的成员抛出带近似名的 TypeError", SLOW, async () => {
  const read = echo("read");
  const issues = echo("mcp_github_issues", "deferred");
  const search = echo("tool_search", "model-only");
  const secret = echo("secret", "hidden");
  const registry = new ToolRegistry([read, issues, search, secret]);
  const bridge = createNestedToolBridge(registry, "call-1");

  assert.deepEqual([...bridge.tools.keys()], ["read", "mcp_github_issues"]);

  const result = await runCodemodeScript(
    `const a = await tools.read({ value: "x" });
     const b = await tools.mcp_github_issues({ value: "y" });
     let missing;
     try { tools.tool_search; } catch (error) { missing = error.name + ": " + error.message; }
     return { a, b, missing };`,
    { tools: bridge.tools },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    const value = result.value as { a: unknown; b: unknown; missing: string };
    assert.deepEqual(value.a, { text: "read:x", details: { name: "read" } });
    assert.deepEqual(value.b, {
      text: "mcp_github_issues:y",
      details: { name: "mcp_github_issues" },
    });
    assert.match(value.missing, /^TypeError: tools\.tool_search does not exist\./);
    assert.match(value.missing, /ALL_TOOLS lists every tool/);
  }
  assert.deepEqual(read.callIds, ["call-1/1"]);
  assert.deepEqual(issues.callIds, ["call-1/2"]);
  assert.equal(search.runs, 0);
  assert.equal(secret.runs, 0);
  assert.deepEqual(bridge.nestedCalls(), {
    calls: [
      { id: "call-1/1", name: "read", status: "ok", arguments: { value: "x" } },
      {
        id: "call-1/2",
        name: "mcp_github_issues",
        status: "ok",
        arguments: { value: "y" },
      },
    ],
    count: 2,
    complete: true,
  });

  const suggestion = await runCodemodeScript(`return tools.readFile;`, {
    tools: bridge.tools,
  });
  assert.equal(suggestion.ok, false);
  if (!suggestion.ok) {
    assert.match(suggestion.error.message, /Did you mean tools\.read\?/);
  }
});

test("Lab 16.2 · 一个嵌套调用失败不会让同批其他调用丢失：参数校验失败与工具抛错都只影响自己", SLOW, async () => {
  const ok = echo("ok");
  const failing: Tool<{ value: string }> = {
    name: "failing",
    description: "always throws",
    schema: objectSchema({ value: stringValue }),
    async execute() {
      throw new Error("failing exploded");
    },
  };
  const registry = new ToolRegistry([ok, failing]);
  const bridge = createNestedToolBridge(registry, "call-2");

  const result = await runCodemodeScript(
    `const settled = await Promise.allSettled([
       tools.ok({ value: "1" }),
       tools.failing({ value: "2" }),
       tools.ok({ value: 3 }),
       tools.ok({ value: "4" }),
     ]);
     return settled.map((entry) => entry.status === "fulfilled" ? entry.value.text : "rejected: " + entry.reason.message);`,
    { tools: bridge.tools },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    const [first, second, third, fourth] = result.value as string[];
    assert.equal(first, "ok:1");
    assert.match(second!, /^rejected: Tool failing failed: failing exploded/);
    assert.match(third!, /^rejected: Tool ok failed: 必须是 string/);
    assert.equal(fourth, "ok:4");
  }
  assert.equal(ok.runs, 2);
  const nested = bridge.nestedCalls();
  assert.deepEqual(
    nested.calls.map((record) => [record.id, record.status]),
    [
      ["call-2/1", "ok"],
      ["call-2/2", "error"],
      ["call-2/3", "error"],
      ["call-2/4", "ok"],
    ],
  );
  assert.match(nested.calls[1]!.error ?? "", /failing exploded/);
  assert.equal("result" in nested.calls[0]!, false);
});

test("Lab 16.2 · nestedCalls 记录有界：超过条数上限的调用照样执行但不记录，超大参数只记字节数，结果从不记录", SLOW, async () => {
  const tool = echo("echo");
  const registry = new ToolRegistry([tool]);
  const bridge = createNestedToolBridge(registry, "call-3", {
    limits: { maxCalls: 2, maxArgumentBytesPerCall: 32 },
  });

  const result = await runCodemodeScript(
    `const big = "x".repeat(40);
     const out = [];
     for (const value of ["a", big, "c", "d"]) out.push((await tools.echo({ value })).text.length);
     return out;`,
    { tools: bridge.tools },
  );

  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, [6, 45, 6, 6]);
  assert.equal(tool.runs, 4);
  assert.deepEqual(tool.callIds, ["call-3/1", "call-3/2", "call-3/3", "call-3/4"]);
  assert.deepEqual(bridge.nestedCalls(), {
    calls: [
      { id: "call-3/1", name: "echo", status: "ok", arguments: { value: "a" } },
      { id: "call-3/2", name: "echo", status: "ok", argumentsBytes: 52 },
    ],
    count: 4,
    complete: false,
  });
});

test("Lab 16.3 · 死循环在 deadline 到期后被中断并 terminate，结果 kind 为 timeout", SLOW, async () => {
  const started = Date.now();
  const result = await runCodemodeScript(`for (;;) {}`, { timeoutMs: 200 });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "timeout");
    assert.match(result.error.message, /timed out after 200 ms/);
  }
  assert.ok(elapsed < 3_000, `terminate 应该很快结束，实际 ${elapsed}ms`);

  const pendingTool = scriptTools({
    wait: (_args, context) =>
      new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () =>
          reject(new Error("tool aborted")),
        );
      }),
  });
  const waiting = await runCodemodeScript(`await tools.wait();`, {
    tools: pendingTool,
    timeoutMs: 100,
  });
  assert.equal(waiting.ok, false);
  if (!waiting.ok) assert.equal(waiting.error.kind, "timeout");
  assert.deepEqual(waiting.calls, [{ name: "wait", status: "cancelled" }]);
});

test("Lab 16.3 · 调用方 abort 时：worker 结束、未完成的嵌套调用收到 abort 信号并记为 cancelled", SLOW, async () => {
  const controller = new AbortController();
  let toolSignal: AbortSignal | undefined;
  const waiting: Tool<{ value: string }> = {
    name: "wait",
    description: "waits for its signal",
    schema: objectSchema({ value: stringValue }),
    execute(_parameters, context) {
      toolSignal = context.signal;
      return new Promise((_resolve, reject) => {
        context.signal?.addEventListener("abort", () =>
          reject(new Error("wait aborted")),
        );
      });
    },
  };
  const registry = new ToolRegistry([waiting]);
  const bridge = createNestedToolBridge(registry, "call-4", {
    signal: controller.signal,
  });

  const running = runCodemodeScript(`await tools.wait({ value: "x" }); return "done";`, {
    tools: bridge.tools,
    signal: controller.signal,
  });
  while (!toolSignal) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(toolSignal.aborted, false);
  controller.abort(new Error("user cancelled"));

  const result = await running;
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "aborted");
    assert.equal(result.error.message, "user cancelled");
  }
  assert.equal(toolSignal.aborted, true);
  assert.deepEqual(result.calls, [{ name: "wait", status: "cancelled" }]);
  assert.deepEqual(
    bridge.nestedCalls().calls.map((record) => record.status),
    ["cancelled"],
  );

  const preAborted = await runCodemodeScript(`return 1;`, {
    signal: AbortSignal.abort(new Error("already")),
  });
  assert.equal(preAborted.ok, false);
  if (!preAborted.ok) assert.equal(preAborted.error.kind, "aborted");
});

test("Lab 16.4 · codemode 是 model-only 工具：成功时内容是返回值 JSON，details 带 nestedCalls；失败时 isError 并给出错误种类与近似名建议", SLOW, async () => {
  const read = echo("read");
  const registry = new ToolRegistry([read]);
  const codemode = createCodemodeTool(registry);
  registry.register(codemode);
  assert.equal(codemode.exposure, "model-only");
  assert.equal(codemode.name, CODEMODE_TOOL_NAME);
  assert.match(codemode.description, /tools\.read\(args\)/);
  assert.doesNotMatch(codemode.description, /tools\.codemode/);

  const success = await executeToolCall(
    call("c1", CODEMODE_TOOL_NAME, {
      code: `console.log("start"); const r = await tools.read({ value: "x" }); return { text: r.text };`,
    }),
    registry,
  );
  assert.equal(success.isError, false);
  assert.equal(success.content[0]!.text, JSON.stringify({ text: "read:x" }));
  assert.deepEqual(detailsOf(success), {
    ok: true,
    output: ["start"],
    nestedCalls: {
      calls: [{ id: "c1/1", name: "read", status: "ok", arguments: { value: "x" } }],
      count: 1,
      complete: true,
    },
  });
  assert.deepEqual(read.callIds, ["c1/1"]);

  const failure = await executeToolCall(
    call("c2", CODEMODE_TOOL_NAME, { code: `return await tools.read_file({ value: "x" });` }),
    registry,
  );
  assert.equal(failure.isError, true);
  assert.match(failure.content[0]!.text, /Script failed: TypeError: tools\.read_file does not exist\. Did you mean tools\.read\?/);
  assert.equal(detailsOf(failure).ok, false);
  assert.equal(detailsOf(failure).error?.kind, "script");
  assert.deepEqual(detailsOf(failure).nestedCalls.calls, []);

  const scriptCannotNest = await executeToolCall(
    call("c3", CODEMODE_TOOL_NAME, { code: `return 1;` }),
    registry,
    {},
    "script",
  );
  assert.equal(scriptCannotNest.isError, true);
  assert.match(scriptCannotNest.content[0]!.text, /不在脚本的可调用集合/);
});

test("Lab 16.4 · 经 loop：脚本调用 deferred 工具不需要先声明，嵌套调用不进入 transcript，只出现在父结果的记录里", SLOW, async () => {
  const read = echo("read");
  const issues = echo("mcp_github_issues", "deferred");
  const registry = new ToolRegistry([read, issues]);
  registry.register(createCodemodeTool(registry));
  const model = new ScriptedModel([
    assistantMessage(
      [
        call("c1", CODEMODE_TOOL_NAME, {
          code: `const [a, b] = await Promise.all([tools.read({ value: "1" }), tools.mcp_github_issues({ value: "2" })]); return a.text + "|" + b.text;`,
        }),
      ],
      "toolUse",
    ),
    assistantMessage([text("done")]),
  ]);

  const result = await runAgentLoop({
    model,
    tools: registry,
    context: { messages: [userMessage("go")] },
  });

  assert.equal(result.reason, "stop");
  assert.deepEqual(
    result.messages.map((message: AgentMessage) => message.role),
    ["user", "system", "assistant", "toolResult", "assistant"],
  );
  const toolResult = result.messages[3] as ToolResultMessage;
  assert.equal(toolResult.toolCallId, "c1");
  assert.equal(toolResult.content[0]!.text, JSON.stringify("read:1|mcp_github_issues:2"));
  assert.deepEqual(
    detailsOf(toolResult).nestedCalls.calls.map((record) => [record.id, record.name]),
    [
      ["c1/1", "read"],
      ["c1/2", "mcp_github_issues"],
    ],
  );
  assert.deepEqual(
    currentTools(result.messages).map((tool) => tool.name),
    ["read", CODEMODE_TOOL_NAME],
  );
  assert.deepEqual(
    model.requests.map((request) => (request.tools ?? []).map((tool) => tool.name)),
    [["read", CODEMODE_TOOL_NAME], ["read", CODEMODE_TOOL_NAME]],
  );
  assert.equal(issues.runs, 1);
});

test("Lab 16.4 · 超时通过 details 报告后 loop 继续；loop 的 abort 让脚本以 aborted 结束，并以 aborted 收口", SLOW, async () => {
  const registry = new ToolRegistry([echo("read")]);
  registry.register(createCodemodeTool(registry, { timeoutMs: 150 }));
  const model = new ScriptedModel([
    assistantMessage([call("c1", CODEMODE_TOOL_NAME, { code: `for (;;) {}` })], "toolUse"),
    assistantMessage([text("recovered")]),
  ]);
  const timedOut = await runAgentLoop({
    model,
    tools: registry,
    context: { messages: [userMessage("go")] },
  });
  assert.equal(timedOut.reason, "stop");
  const timeoutResult = timedOut.messages[3] as ToolResultMessage;
  assert.equal(timeoutResult.isError, true);
  assert.equal(detailsOf(timeoutResult).error?.kind, "timeout");

  const controller = new AbortController();
  let started = false;
  const waiting: Tool<{ value: string }> = {
    name: "wait",
    description: "waits",
    schema: objectSchema({ value: stringValue }),
    execute(_parameters, context) {
      started = true;
      return new Promise((_resolve, reject) => {
        context.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    },
  };
  const abortable = new ToolRegistry([waiting]);
  abortable.register(createCodemodeTool(abortable));
  const abortModel = new ScriptedModel([
    assistantMessage(
      [call("c2", CODEMODE_TOOL_NAME, { code: `await tools.wait({ value: "x" });` })],
      "toolUse",
    ),
  ]);
  const running = runAgentLoop({
    model: abortModel,
    tools: abortable,
    signal: controller.signal,
    context: { messages: [userMessage("go")] },
  });
  while (!started) await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  const aborted = await running;
  assert.equal(aborted.reason, "aborted");
  const abortedResult = aborted.messages[3] as ToolResultMessage;
  assert.equal(detailsOf(abortedResult).error?.kind, "aborted");
  assert.deepEqual(
    detailsOf(abortedResult).nestedCalls.calls.map((record) => record.status),
    ["cancelled"],
  );
});
