import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop, type LoopEvent } from "../src/agent-loop.js";
import { ScriptedModel } from "../src/scripted-model.js";
import {
  objectSchema,
  stringValue,
  ToolRegistry,
  type Tool,
  type ToolExecutor,
} from "../src/tool.js";
import {
  assistantMessage,
  currentSystemPrompt,
  text,
  userMessage,
  type AgentContext,
  type AgentMessage,
  type ToolCall,
  type ToolResultMessage,
} from "../src/types.js";

function call(id: string, name: string, args: unknown): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function resultFor(
  currentCall: ToolCall,
  value: string,
  isError = false,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: currentCall.id,
    toolName: currentCall.name,
    content: [text(value)],
    isError,
    timestamp: Date.now(),
  };
}

function toolResults(messages: AgentMessage[]): ToolResultMessage[] {
  return messages.filter(
    (message): message is ToolResultMessage =>
      message.role === "toolResult",
  );
}

function assertSingleEnd(
  events: LoopEvent[],
  reason: "stop" | "length" | "error" | "aborted" | "maxSteps",
): void {
  assert.deepEqual(
    events.filter((event) => event.type === "turn_end"),
    [{ type: "turn_end", reason }],
  );
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const echoTool: Tool<{ value: string }> = {
  name: "echo",
  description: "echo",
  schema: objectSchema({ value: stringValue }),
  async execute({ value }) {
    return { content: [text(value)] };
  },
};

test("Lab 7.1 · 纯文本 stop 保留输入并完整传递模型 context", async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  const context: AgentContext = {
    messages: [
      { role: "system", content: "You are Pi.", timestamp: 0 },
      userMessage("explain the loop"),
    ],
    tools: [
      {
        name: "stale-definition",
        description: "must not reach the model",
        parameters: { type: "object" },
      },
    ],
  };
  const before = structuredClone(context);
  const events: LoopEvent[] = [];
  const model = new ScriptedModel([
    assistantMessage([text("A loop closes over evidence.")], "stop"),
  ]);

  const run = await runAgentLoop({
    model,
    tools: registry,
    context,
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(context, before);
  assert.notEqual(run.messages, context.messages);
  assert.deepEqual(
    run.messages.map((message) => message.role),
    ["system", "user", "assistant"],
  );
  assert.equal(model.requests.length, 1);
  const systemPrompt = currentSystemPrompt(model.requests[0]?.messages ?? []);
  assert.equal(systemPrompt, "You are Pi.");
  assert.equal("systemPrompt" in (model.requests[0] ?? {}), false);
  assert.deepEqual(model.requests[0]?.messages, before.messages);
  assert.deepEqual(model.requests[0]?.tools, registry.definitions());
  assert.equal(run.reason, "stop");
  assert.equal(run.steps, 1);
  assertSingleEnd(events, "stop");
});

test("Lab 7.2 · loop 从不写入 system message：transcript 只追加，请求以调用方 messages 为前缀", async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  const context: AgentContext = {
    messages: [
      {
        role: "system",
        content: "BASE",
        sections: { rules: "RULE v1" },
        timestamp: 0,
      },
      userMessage("first"),
      assistantMessage([text("ok")], "stop"),
      {
        role: "system",
        content: "",
        sections: { rules: "RULE v2" },
        timestamp: 2,
      },
      userMessage("second"),
    ],
  };
  const before = structuredClone(context);
  const toolCall = call("echo-1", "echo", { value: "hi" });
  const model = new ScriptedModel([
    assistantMessage([toolCall], "toolUse"),
    assistantMessage([text("done")], "stop"),
  ]);

  const run = await runAgentLoop({ model, tools: registry, context });

  assert.equal(run.reason, "stop");
  assert.deepEqual(
    run.messages.slice(0, before.messages.length),
    before.messages,
    "调用方给的 messages（含 system message）是不变前缀",
  );
  assert.deepEqual(
    run.messages.slice(before.messages.length).map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
    "loop 只追加 assistant 与 toolResult",
  );
  assert.equal(model.requests.length, 2);
  for (const request of model.requests) {
    assert.deepEqual(
      request.messages.slice(0, before.messages.length),
      before.messages,
    );
    assert.equal(
      request.messages.filter((message) => message.role === "system").length,
      2,
      "system message 留在 transcript 原位，折叠是第 05 章 adapter 的事",
    );
    assert.equal(currentSystemPrompt(request.messages), "BASE\n\nRULE v2");
  }
  assert.deepEqual(context, before);
});

test("Lab 7.2 · 单工具往返传递 signal/progress 并完整回填下一请求", async () => {
  const controller = new AbortController();
  const progress = [text("halfway")];
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: "probe",
    description: "observe tool context",
    schema: objectSchema({ value: stringValue }),
    async execute({ value }, context) {
      executions += 1;
      assert.equal(context.callId, "probe-1");
      assert.equal(context.signal, controller.signal);
      context.reportProgress?.(progress);
      return {
        content: [text(`observed:${value}`)],
        details: { source: "probe" },
      };
    },
  });
  const initial = userMessage("inspect");
  const context: AgentContext = {
    messages: [initial],
  };
  const before = structuredClone(context);
  const toolCall = call("probe-1", "probe", { value: "signal" });
  const model = new ScriptedModel([
    assistantMessage([toolCall], "toolUse"),
    assistantMessage([text("done")], "stop"),
  ]);
  const events: LoopEvent[] = [];

  const run = await runAgentLoop({
    model,
    tools: registry,
    context,
    signal: controller.signal,
    onEvent: (event) => events.push(event),
  });

  assert.equal(executions, 1);
  assert.deepEqual(context, before);
  assert.equal(model.requests.length, 2);
  assert.deepEqual(
    model.requests[1]?.messages.map((message) => message.role),
    ["user", "assistant", "toolResult"],
  );
  assert.deepEqual(model.requests[1]?.tools, registry.definitions());
  assert.deepEqual(
    run.messages.map((message) => message.role),
    ["user", "assistant", "toolResult", "assistant"],
  );
  assert.deepEqual(
    events
      .filter(
        (
          event,
        ): event is Extract<LoopEvent, { type: "assistant_message" }> =>
          event.type === "assistant_message",
      )
      .map((event) => event.message.stopReason),
    ["toolUse", "stop"],
  );
  const paired = toolResults(run.messages);
  assert.equal(paired.length, 1);
  assert.equal(paired[0]?.toolCallId, toolCall.id);
  assert.equal(paired[0]?.toolName, toolCall.name);
  assert.deepEqual(paired[0]?.content, [text("observed:signal")]);
  assert.deepEqual(paired[0]?.details, { source: "probe" });
  assert.deepEqual(
    events.filter((event) => event.type === "tool_progress"),
    [{ type: "tool_progress", callId: "probe-1", content: progress }],
  );
  assert.deepEqual(
    events
      .filter(
        (event) =>
          event.type === "tool_start" ||
          event.type === "tool_progress" ||
          event.type === "tool_end",
      )
      .map((event) => event.type),
    ["tool_start", "tool_progress", "tool_end"],
  );
  assert.equal(
    events.filter((event) => event.type === "tool_start").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "tool_end").length,
    1,
  );
  assert.equal(run.reason, "stop");
  assertSingleEnd(events, "stop");
});

test("Lab 7.3 · 非执行终态：length、error 与 aborted 的 calls 全部跳过并逐一配对", async () => {
  for (const reason of ["length", "error", "aborted"] as const) {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register({
      ...echoTool,
      async execute({ value }) {
        executions += 1;
        return { content: [text(value)] };
      },
    });
    const calls = [
      call(`${reason}-1`, "echo", { value: "first" }),
      call(`${reason}-2`, "echo", { value: "second" }),
    ];
    const events: LoopEvent[] = [];

    const run = await runAgentLoop({
      model: new ScriptedModel([
        assistantMessage(calls, reason, {
          errorMessage:
            reason === "error" ? "provider failed" : undefined,
        }),
      ]),
      tools: registry,
      context: { messages: [userMessage("run")] },
      onEvent: (event) => events.push(event),
    });

    assert.equal(executions, 0, `${reason} must never execute tools`);
    assert.equal(run.reason, reason);
    assert.deepEqual(
      toolResults(run.messages).map((result) => ({
        id: result.toolCallId,
        name: result.toolName,
        error: result.isError,
        details: result.details,
      })),
      calls.map((currentCall) => ({
        id: currentCall.id,
        name: currentCall.name,
        error: true,
        details: { skipped: true, reason },
      })),
    );
    assert.equal(
      events.filter((event) => event.type === "tool_start").length,
      0,
    );
    assert.equal(
      events.filter((event) => event.type === "tool_skipped").length,
      2,
    );
    assertSingleEnd(events, reason);
  }
});

test("Lab 7.3 · 非执行终态：stop 夹带 call 与 toolUse 无 call 都以协议 error 结束", async () => {
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register({
    ...echoTool,
    async execute({ value }) {
      executions += 1;
      return { content: [text(value)] };
    },
  });
  const malformedCall = call("stop-call", "echo", { value: "never" });
  const stopEvents: LoopEvent[] = [];
  const malformedStop = await runAgentLoop({
    model: new ScriptedModel([
      assistantMessage([malformedCall], "stop"),
    ]),
    tools: registry,
    context: { messages: [userMessage("run")] },
    onEvent: (event) => stopEvents.push(event),
  });

  assert.equal(executions, 0);
  assert.equal(malformedStop.reason, "error");
  assert.deepEqual(
    toolResults(malformedStop.messages).map((result) => ({
      id: result.toolCallId,
      name: result.toolName,
      isError: result.isError,
      details: result.details,
    })),
    [
      {
        id: malformedCall.id,
        name: malformedCall.name,
        isError: true,
        details: { skipped: true, reason: "unexpected-stop" },
      },
    ],
  );
  assertSingleEnd(stopEvents, "error");

  const emptyToolUseEvents: LoopEvent[] = [];
  const emptyToolUse = await runAgentLoop({
    model: new ScriptedModel([
      assistantMessage([text("missing call")], "toolUse"),
    ]),
    tools: registry,
    context: { messages: [userMessage("run")] },
    onEvent: (event) => emptyToolUseEvents.push(event),
  });

  assert.equal(emptyToolUse.reason, "error");
  assert.equal(toolResults(emptyToolUse.messages).length, 0);
  assertSingleEnd(emptyToolUseEvents, "error");
});

test(
  "Lab 7.4 · 并发工具：可控 gate 分离 tool_end 完成顺序与 transcript call 顺序",
  { timeout: 1_000 },
  async () => {
    const slowGate = deferred<string>();
    const fastGate = deferred<string>();
    const bothStarted = deferred<void>();
    const fastEnded = deferred<void>();
    let started = 0;
    const gated = (
      name: string,
      gate: Deferred<string>,
    ): Tool<{ value: string }> => ({
      name,
      description: name,
      schema: objectSchema({ value: stringValue }),
      async execute({ value }) {
        started += 1;
        if (started === 2) bothStarted.resolve(undefined);
        await gate.promise;
        return { content: [text(value)] };
      },
    });
    const registry = new ToolRegistry();
    registry.register(gated("slow", slowGate));
    registry.register(gated("fast", fastGate));
    const calls = [
      call("slow-call", "slow", { value: "S" }),
      call("fast-call", "fast", { value: "F" }),
    ];
    const model = new ScriptedModel([
      assistantMessage(calls, "toolUse"),
      assistantMessage([text("done")], "stop"),
    ]);
    const events: LoopEvent[] = [];

    const pending = runAgentLoop({
      model,
      tools: registry,
      context: { messages: [userMessage("run")] },
      onEvent: (event) => {
        events.push(event);
        if (
          event.type === "tool_end" &&
          event.result.toolCallId === "fast-call"
        ) {
          fastEnded.resolve(undefined);
        }
      },
    });
    await bothStarted.promise;
    fastGate.resolve("release");
    await fastEnded.promise;
    slowGate.resolve("release");
    const run = await pending;

    assert.deepEqual(
      events
        .filter((event) => event.type === "tool_end")
        .map((event) =>
          event.type === "tool_end" ? event.result.toolCallId : ""
        ),
      ["fast-call", "slow-call"],
    );
    assert.deepEqual(
      toolResults(run.messages).map((result) => result.toolCallId),
      ["slow-call", "fast-call"],
    );
    assert.deepEqual(
      toolResults(model.requests[1]?.messages ?? []).map(
        (result) => result.toolCallId,
      ),
      ["slow-call", "fast-call"],
    );
    assert.deepEqual(
      toolResults(run.messages).map((result) => result.toolName),
      ["slow", "fast"],
    );
    assertSingleEnd(events, "stop");
  },
);

test(
  "Lab 7.4 · 并发工具：injected executor rejection 被归一化且不阻断同批结果",
  { timeout: 1_000 },
  async () => {
    const goodStarted = deferred<void>();
    const releaseGood = deferred<void>();
    const calls = [
      call("bad-call", "bad", {}),
      call("good-call", "good", {}),
    ];
    const executor: ToolExecutor = async (currentCall, context) => {
      if (currentCall.id === "bad-call") {
        const error = new Error("executor exploded");
        error.stack = "STACK_SECRET";
        throw error;
      }
      goodStarted.resolve(undefined);
      await releaseGood.promise;
      context?.reportProgress?.([text("good still running")]);
      return resultFor(currentCall, "good result");
    };
    const events: LoopEvent[] = [];
    const model = new ScriptedModel([
      assistantMessage(calls, "toolUse"),
      assistantMessage([text("done")], "stop"),
    ]);

    const pending = runAgentLoop({
      model,
      tools: new ToolRegistry(),
      context: { messages: [userMessage("run")] },
      executeToolCall: executor,
      onEvent: (event) => events.push(event),
    });
    await goodStarted.promise;
    releaseGood.resolve(undefined);
    const run = await pending;

    assert.equal(run.reason, "stop");
    const results = toolResults(run.messages);
    assert.deepEqual(
      results.map((result) => result.toolCallId),
      ["bad-call", "good-call"],
    );
    assert.deepEqual(
      results.map((result) => result.toolName),
      ["bad", "good"],
    );
    assert.equal(results[0]?.isError, true);
    assert.equal(results[1]?.isError, false);
    assert.match(JSON.stringify(results[0]), /executor exploded/);
    assert.doesNotMatch(
      JSON.stringify(results[0]),
      /STACK_SECRET|stack/i,
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === "tool_end")
        .map((event) =>
          event.type === "tool_end" ? event.result.toolCallId : ""
        )
        .sort(),
      ["bad-call", "good-call"],
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "tool_progress" &&
          event.callId === "good-call",
      ),
      true,
    );
    assertSingleEnd(events, "stop");
  },
);

test("Lab 7.5 · 取消与上限：预取消不请求模型且只产生一个 aborted 终态", async () => {
  const controller = new AbortController();
  controller.abort();
  const initial = userMessage("do not start");
  const model = new ScriptedModel([
    assistantMessage([text("unreachable")], "stop"),
  ]);
  const events: LoopEvent[] = [];

  const run = await runAgentLoop({
    model,
    tools: new ToolRegistry(),
    context: { messages: [initial] },
    signal: controller.signal,
    onEvent: (event) => events.push(event),
  });

  assert.equal(run.reason, "aborted");
  assert.equal(run.steps, 0);
  assert.deepEqual(run.messages, [initial]);
  assert.equal(model.requests.length, 0);
  assertSingleEnd(events, "aborted");
});

test("Lab 7.5 · 取消与上限：工具完成后取消保留配对结果且不再请求模型", async () => {
  const controller = new AbortController();
  let seenSignal: AbortSignal | undefined;
  const registry = new ToolRegistry();
  registry.register({
    name: "cancel-after",
    description: "abort after producing evidence",
    schema: objectSchema({ value: stringValue }),
    async execute({ value }, context) {
      seenSignal = context.signal;
      controller.abort();
      return { content: [text(value)] };
    },
  });
  const currentCall = call("cancel-call", "cancel-after", {
    value: "kept",
  });
  const model = new ScriptedModel([
    assistantMessage([currentCall], "toolUse"),
    assistantMessage([text("must not be requested")], "stop"),
  ]);
  const events: LoopEvent[] = [];

  const run = await runAgentLoop({
    model,
    tools: registry,
    context: { messages: [userMessage("run")] },
    signal: controller.signal,
    onEvent: (event) => events.push(event),
  });

  assert.equal(seenSignal, controller.signal);
  assert.equal(run.reason, "aborted");
  assert.equal(run.steps, 1);
  assert.equal(model.requests.length, 1);
  assert.deepEqual(
    toolResults(run.messages).map((result) => ({
      id: result.toolCallId,
      name: result.toolName,
      text: result.content,
    })),
    [
      {
        id: currentCall.id,
        name: currentCall.name,
        text: [text("kept")],
      },
    ],
  );
  assert.equal(
    events.filter((event) => event.type === "tool_end").length,
    1,
  );
  assertSingleEnd(events, "aborted");
});

test("Lab 7.5 · 取消与上限：maxSteps 保留最后一批结果并产生唯一控制器终态", async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  const currentCall = call("last-call", "echo", { value: "kept" });
  const model = new ScriptedModel([
    assistantMessage([currentCall], "toolUse"),
    assistantMessage([text("must not be requested")], "stop"),
  ]);
  const events: LoopEvent[] = [];

  const run = await runAgentLoop({
    model,
    tools: registry,
    context: { messages: [userMessage("run")] },
    maxSteps: 1,
    onEvent: (event) => events.push(event),
  });

  assert.equal(run.reason, "maxSteps");
  assert.equal(run.steps, 1);
  assert.equal(model.requests.length, 1);
  assert.deepEqual(
    toolResults(run.messages).map((result) => ({
      id: result.toolCallId,
      name: result.toolName,
      content: result.content,
    })),
    [
      {
        id: currentCall.id,
        name: currentCall.name,
        content: [text("kept")],
      },
    ],
  );
  assertSingleEnd(events, "maxSteps");
});
