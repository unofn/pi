import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  Agent,
  reduceAgentState,
  type AgentEvent,
  type AgentState,
} from "../src/agent.js";
import {
  type AgentRunResult,
  type LoopEvent,
} from "../src/agent-loop.js";
import { createCodingTools } from "../src/coding-tools.js";
import { AssistantMessageEventStream } from "../src/event-stream.js";
import { ScriptedModel } from "../src/scripted-model.js";
import type { ToolExecutor } from "../src/tool.js";
import {
  assistantMessage,
  currentSystemPrompt,
  text,
  textOf,
  userMessage,
  type AgentContext,
  type AssistantMessage,
  type Model,
  type ToolCall,
  type ToolResultMessage,
} from "../src/types.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function toolCall(id: string, name = "probe"): ToolCall {
  return {
    type: "toolCall",
    id,
    name,
    arguments: {},
  };
}

function toolResult(
  call: ToolCall,
  value: string,
  isError = false,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [text(value)],
    isError,
    timestamp: Date.now(),
  };
}

function initialState(messages: AgentState["messages"] = []): AgentState {
  return {
    status: "idle",
    messages,
    streamingText: "",
    pendingToolCallIds: [],
    diagnostics: [],
  };
}

function loopEvent(runId: number, event: LoopEvent): AgentEvent {
  return { type: "loop", runId, event };
}

async function createAgent(
  t: TestContext,
  model: Model,
  options: { toolExecutor?: ToolExecutor; systemPrompt?: string } = {},
): Promise<Agent> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-course-agent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new Agent({
    model,
    tools: createCodingTools({
      cwd: root,
      containment: "workspace",
    }),
    toolExecutor: options.toolExecutor,
    systemPrompt: options.systemPrompt,
  });
}

function completeStream(
  stream: AssistantMessageEventStream,
  message: AssistantMessage,
): void {
  const partial: AssistantMessage = {
    ...structuredClone(message),
    content: [],
    stopReason: "stop" as const,
  };
  stream.push({ type: "start", partial: structuredClone(partial) });
  for (const [contentIndex, block] of message.content.entries()) {
    if (block.type === "text") {
      partial.content.push(structuredClone(block));
      stream.push({
        type: "text_delta",
        contentIndex,
        delta: block.text,
        partial: structuredClone(partial),
      });
    }
  }
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({
      type: "error",
      reason: message.stopReason,
      error: structuredClone(message),
    });
    return;
  }
  stream.push({
    type: "done",
    reason: message.stopReason,
    message: structuredClone(message),
  });
}

class ManualModel implements Model {
  readonly requests: AgentContext[] = [];
  readonly signals: Array<AbortSignal | undefined> = [];
  readonly streams: AssistantMessageEventStream[] = [];

  constructor(private readonly honorAbort = true) {}

  stream(
    context: AgentContext,
    options: { signal?: AbortSignal } = {},
  ): AssistantMessageEventStream {
    const stream = new AssistantMessageEventStream();
    this.requests.push(structuredClone(context));
    this.signals.push(options.signal);
    this.streams.push(stream);

    const abort = () => {
      const message = assistantMessage([], "aborted", {
        errorMessage: "manual model aborted",
      });
      stream.push({
        type: "error",
        reason: "aborted",
        error: message,
      });
    };
    if (this.honorAbort) {
      if (options.signal?.aborted) queueMicrotask(abort);
      else options.signal?.addEventListener("abort", abort, { once: true });
    }
    return stream;
  }

  complete(index: number, message: AssistantMessage): void {
    const stream = this.streams[index];
    if (!stream) throw new Error(`manual stream ${index} 尚未开始`);
    completeStream(stream, message);
  }
}

class SignalCapturingModel implements Model {
  readonly signals: Array<AbortSignal | undefined> = [];

  constructor(readonly inner: ScriptedModel) {}

  stream(
    context: AgentContext,
    options: { signal?: AbortSignal } = {},
  ) {
    this.signals.push(options.signal);
    return this.inner.stream(context, options);
  }
}

class ThrowOnSecondRequestModel implements Model {
  readonly requests: AgentContext[] = [];
  private readonly scripted: ScriptedModel;

  constructor(call: ToolCall) {
    this.scripted = new ScriptedModel([
      assistantMessage([call], "toolUse"),
      assistantMessage([text("clean retry")]),
    ]);
  }

  stream(
    context: AgentContext,
    options: { signal?: AbortSignal } = {},
  ) {
    this.requests.push(structuredClone(context));
    if (this.requests.length === 2) {
      throw new Error("provider stream failed");
    }
    return this.scripted.stream(context, options);
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("等待可观察状态超时");
}

test("Lab 9.1 · reducer 派生流式文本、待处理工具与运行终态，不修改输入", () => {
  const previousMessage = userMessage("history");
  const original = initialState([previousMessage]);
  const originalSnapshot = structuredClone(original);
  const firstMessage = userMessage("start");
  const running = reduceAgentState(original, {
    type: "run_start",
    runId: 1,
    message: firstMessage,
  });
  assert.equal(running.status, "running");
  assert.equal(running.activeRunId, 1);
  assert.deepEqual(running.messages, [previousMessage, firstMessage]);
  assert.notEqual(running.messages, original.messages);
  assert.deepEqual(original, originalSnapshot);
  previousMessage.content[0].text = "mutated old history";
  firstMessage.content[0].text = "mutated after reduce";
  assert.equal(textOf(running.messages[0]), "history");
  assert.equal(textOf(running.messages[1]), "start");
  previousMessage.content[0].text = "history";
  firstMessage.content[0].text = "start";

  const partial = assistantMessage([text("hel")]);
  const streamed = reduceAgentState(
    running,
    loopEvent(1, {
      type: "model_event",
      event: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hel",
        partial,
      },
    }),
  );
  assert.equal(streamed.streamingText, "hel");

  const call = toolCall("call-1");
  const started = reduceAgentState(
    streamed,
    loopEvent(1, { type: "tool_start", call }),
  );
  assert.deepEqual(started.pendingToolCallIds, ["call-1"]);
  assert.deepEqual(streamed.pendingToolCallIds, []);
  const ended = reduceAgentState(
    started,
    loopEvent(1, {
      type: "tool_end",
      result: toolResult(call, "done"),
    }),
  );
  assert.deepEqual(ended.pendingToolCallIds, []);
  const assistantEnded = reduceAgentState(
    ended,
    loopEvent(1, {
      type: "assistant_message",
      message: assistantMessage([text("hello")]),
    }),
  );
  assert.equal(assistantEnded.streamingText, "");

  const finalMessages = [
    firstMessage,
    assistantMessage([text("hello")]),
  ];
  const idle = reduceAgentState(assistantEnded, {
    type: "run_end",
    runId: 1,
    result: { reason: "stop", messages: finalMessages, steps: 1 },
  });
  assert.equal(idle.status, "idle");
  assert.equal(idle.activeRunId, undefined);
  assert.equal(idle.lastReason, "stop");
  assert.deepEqual(idle.messages, finalMessages);
  assert.notEqual(idle.messages, finalMessages);
  const finalInput = finalMessages[0].content[0];
  if (finalInput?.type === "text") {
    finalInput.text = "mutated final input";
  }
  assert.equal(textOf(idle.messages[0]), "start");
});

test("Lab 9.1 · reducer 忽略不属于当前 run 的迟到事件", () => {
  const current = reduceAgentState(initialState(), {
    type: "run_start",
    runId: 2,
    message: userMessage("current"),
  });
  const staleLoop = reduceAgentState(
    current,
    loopEvent(1, {
      type: "model_event",
      event: {
        type: "text_delta",
        contentIndex: 0,
        delta: "STALE",
        partial: assistantMessage([text("STALE")]),
      },
    }),
  );
  const staleEnd = reduceAgentState(current, {
    type: "run_end",
    runId: 1,
    result: {
      reason: "stop",
      messages: [userMessage("stale")],
      steps: 1,
    },
  });

  assert.equal(staleLoop, current);
  assert.equal(staleEnd, current);
  assert.equal(current.streamingText, "");
  assert.equal(current.status, "running");
  assert.equal(current.activeRunId, 2);
});

test("Lab 9.2 · busy guard 拒绝并行 prompt，顺序运行共享 transcript", async (t) => {
  const model = new ScriptedModel([
    assistantMessage([text("first")]),
    assistantMessage([text("second")]),
  ]);
  const agent = await createAgent(t, model);

  const first = agent.prompt("one");
  await assert.rejects(agent.prompt("parallel"), /Agent is busy/);
  assert.equal((await first).reason, "stop");
  assert.equal((await agent.prompt("two")).reason, "stop");

  assert.equal(model.requests.length, 2);
  assert.deepEqual(
    model.requests[1].messages.map((message) => message.role),
    ["user", "assistant", "user"],
  );
  assert.deepEqual(
    agent.getState().messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.equal(agent.getState().status, "idle");
  assert.equal(agent.getState().lastReason, "stop");

  const call = toolCall("write-before-provider-error");
  const throwingModel = new ThrowOnSecondRequestModel(call);
  let sideEffects = 0;
  const recovering = await createAgent(t, throwingModel, {
    toolExecutor: async (currentCall) => {
      sideEffects += 1;
      return toolResult(currentCall, "write committed");
    },
  });
  const runEnds: number[] = [];
  recovering.subscribe((event) => {
    if (event.type === "run_end") runEnds.push(event.runId);
  });

  const failed = await recovering.prompt("change a file");
  assert.equal(failed.reason, "error");
  assert.equal(sideEffects, 1);
  assert.deepEqual(
    failed.messages.map((message) => message.role),
    ["user", "assistant", "toolResult", "assistant"],
  );
  assert.match(textOf(failed.messages[2]), /write committed/);
  const failureMessage = failed.messages.at(-1);
  assert.match(
    failureMessage?.role === "assistant"
      ? failureMessage.errorMessage ?? ""
      : "",
    /provider stream failed/,
  );
  assert.equal(recovering.getState().status, "idle");
  assert.deepEqual(runEnds, [1]);
  assert.equal((await recovering.prompt("retry")).reason, "stop");
  assert.deepEqual(runEnds, [1, 2]);
});

test("Lab 9.2 · run_end listener 启动的新运行不受旧 cleanup 影响", async (t) => {
  const model = new ManualModel();
  const agent = await createAgent(t, model);
  let secondPrompt: Promise<AgentRunResult> | undefined;
  const lifecycle: string[] = [];
  agent.subscribe((event) => {
    if (event.type === "run_end" && event.runId === 1) {
      secondPrompt = agent.prompt("second");
    }
  });
  agent.subscribe((event) => {
    if (event.type === "run_start" || event.type === "run_end") {
      lifecycle.push(`${event.type}:${event.runId}`);
    }
  });

  const firstPrompt = agent.prompt("first");
  model.complete(0, assistantMessage([text("first done")]));
  assert.equal((await firstPrompt).reason, "stop");
  assert.ok(secondPrompt);
  await waitUntil(() => model.streams.length === 2);
  assert.equal(model.streams.length, 2);
  assert.deepEqual(
    model.requests[1].messages.map((message) => message.role),
    ["user", "assistant", "user"],
  );
  assert.equal(textOf(model.requests[1].messages.at(-1)!), "second");

  const thirdOutcome = agent.prompt("parallel third").then(
    (result) => ({ status: "fulfilled" as const, result }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  await Promise.resolve();
  if (model.streams.at(2)) {
    model.complete(2, assistantMessage([text("wrongly admitted")]));
  }
  const third = await thirdOutcome;
  assert.equal(third.status, "rejected");
  if (third.status === "rejected") {
    assert.match(String(third.error), /Agent is busy/);
  }

  model.complete(1, assistantMessage([text("second done")]));
  assert.equal((await secondPrompt).reason, "stop");
  assert.equal(agent.getState().status, "idle");
  assert.deepEqual(lifecycle, [
    "run_start:1",
    "run_end:1",
    "run_start:2",
    "run_end:2",
  ]);
});

test("Lab 9.2 · systemPrompt 成为开头 system message，prompt 的 system 补丁只追加在用户消息之前", async (t) => {
  const model = new ScriptedModel([
    assistantMessage([text("first")]),
    assistantMessage([text("second")]),
    assistantMessage([text("third")]),
  ]);
  const agent = await createAgent(t, model, { systemPrompt: "BASE" });
  assert.deepEqual(agent.getState().messages, [
    { role: "system", content: "BASE", timestamp: 0 },
  ]);
  assert.equal(agent.systemPrompt, "BASE");
  const starts: AgentEvent[] = [];
  agent.subscribe((event) => {
    if (event.type === "run_start") starts.push(event);
  });

  const plain = await agent.prompt("one");
  assert.deepEqual(
    plain.messages.map((message) => message.role),
    ["system", "user", "assistant"],
  );
  assert.equal(currentSystemPrompt(model.requests[0]!.messages), "BASE");
  assert.equal("systemPrompt" in model.requests[0]!, false);

  const patched = await agent.prompt("two", {
    system: { sections: { rules: "RULE v1" } },
  });
  assert.deepEqual(
    patched.messages.map((message) => message.role),
    ["system", "user", "assistant", "system", "user", "assistant"],
  );
  const patch = patched.messages[3];
  assert.ok(patch?.role === "system");
  assert.equal(patch.content, "");
  assert.deepEqual(patch.sections, { rules: "RULE v1" });
  assert.equal(agent.systemPrompt, "BASE\n\nRULE v1");
  assert.equal(
    currentSystemPrompt(model.requests[1]!.messages),
    "BASE\n\nRULE v1",
  );
  assert.equal(
    model.requests[1]!.messages.filter((message) => message.role === "system")
      .length,
    2,
    "补丁留在 transcript 原位，不折叠、不改写开头 system message",
  );
  assert.deepEqual(
    agent.getState().messages.slice(0, 3),
    plain.messages,
    "已有前缀不被改写",
  );
  const secondStart = starts[1];
  assert.ok(secondStart?.type === "run_start");
  assert.deepEqual(secondStart.system?.sections, { rules: "RULE v1" });
  assert.deepEqual(
    reduceAgentState(initialState(), secondStart).messages.map(
      (message) => message.role,
    ),
    ["system", "user"],
    "reducer 把 system 补丁放在用户消息之前",
  );

  const removed = await agent.prompt("three", {
    system: { content: "Prefer small diffs.", sections: { rules: null } },
  });
  assert.equal(agent.systemPrompt, "BASE\n\nPrefer small diffs.");
  assert.equal(
    removed.messages.filter((message) => message.role === "system").length,
    3,
  );
  assert.equal(
    currentSystemPrompt(model.requests[2]!.messages),
    "BASE\n\nPrefer small diffs.",
  );

  const bare = await createAgent(t, new ScriptedModel([]));
  assert.deepEqual(bare.getState().messages, []);
  assert.equal(bare.systemPrompt, undefined);
  const empty = await createAgent(t, new ScriptedModel([]), {
    systemPrompt: "",
  });
  assert.deepEqual(empty.getState().messages, []);
});

test("Lab 9.3 · state 先更新再通知，坏 subscriber 与 unsubscribe 互不干扰", async (t) => {
  const model = new ScriptedModel([
    assistantMessage([text("first")]),
    assistantMessage([text("second")]),
    assistantMessage([text("third")]),
  ]);
  const agent = await createAgent(t, model);
  let observedStarts = 0;
  const unsubscribeBroken = agent.subscribe((event) => {
    if (event.type === "run_start") throw new Error("broken renderer");
  });
  const unsubscribeObserver = agent.subscribe((event) => {
    if (event.type === "run_start") {
      observedStarts += 1;
      assert.equal(agent.getState().status, "running");
      assert.equal(agent.getState().activeRunId, event.runId);
    }
  });

  assert.equal((await agent.prompt("one")).reason, "stop");
  assert.equal(observedStarts, 1);
  assert.match(agent.getState().diagnostics[0], /broken renderer/);
  unsubscribeBroken();

  assert.equal((await agent.prompt("two")).reason, "stop");
  assert.equal(observedStarts, 2);
  assert.equal(agent.getState().diagnostics.length, 1);
  unsubscribeObserver();

  assert.equal((await agent.prompt("three")).reason, "stop");
  assert.equal(observedStarts, 2);
  assert.equal(agent.getState().diagnostics.length, 1);
});

test("Lab 9.3 · state、subscriber event 与 prompt result 不共享可变引用", async (t) => {
  const model = new ScriptedModel([
    assistantMessage([text("answer")]),
  ]);
  const agent = await createAgent(t, model);
  let secondSubscriberLength = -1;
  let secondSubscriberFirstText = "";
  agent.subscribe((event) => {
    if (event.type !== "run_end") return;
    event.result.messages.push(userMessage("subscriber mutation"));
    const first = event.result.messages[0];
    if (first?.role === "user" && first.content[0]?.type === "text") {
      first.content[0].text = "subscriber changed";
    }
  });
  agent.subscribe((event) => {
    if (event.type !== "run_end") return;
    secondSubscriberLength = event.result.messages.length;
    secondSubscriberFirstText = textOf(event.result.messages[0]);
  });

  const result = await agent.prompt("question");
  assert.equal(result.messages.length, 2);
  assert.equal(textOf(result.messages[0]), "question");
  assert.equal(secondSubscriberLength, 2);
  assert.equal(secondSubscriberFirstText, "question");

  result.messages.push(userMessage("caller mutation"));
  const snapshot = agent.getState();
  snapshot.messages.push(userMessage("snapshot mutation"));
  const first = snapshot.messages[0];
  if (first?.role === "user" && first.content[0]?.type === "text") {
    first.content[0].text = "changed";
  }

  const internal = agent.getState();
  assert.equal(internal.messages.length, 2);
  assert.equal(textOf(internal.messages[0]), "question");

  const malformedCall = toolCall("uncloneable-details");
  const malformedModel = new ScriptedModel([
    assistantMessage([malformedCall], "toolUse"),
    assistantMessage([text("recovered from malformed result")]),
  ]);
  const malformed = await createAgent(t, malformedModel, {
    toolExecutor: async (call) => ({
      ...toolResult(call, "raw result"),
      details: { callback: () => "not cloneable" },
    }),
  });
  const normalized = await malformed.prompt("run malformed tool");
  assert.equal(normalized.reason, "stop");
  const normalizedToolResult = normalized.messages.find(
    (message): message is ToolResultMessage =>
      message.role === "toolResult",
  );
  assert.ok(normalizedToolResult);
  assert.equal(normalizedToolResult.isError, true);
  assert.match(textOf(normalizedToolResult), /structured-cloneable/);
  assert.equal(malformed.getState().status, "idle");
});

test("Lab 9.4 · 预取消只产生一个 run_end，下一次 prompt 使用新 controller", async (t) => {
  const model = new ScriptedModel([
    assistantMessage([text("reachable on second run")]),
  ]);
  const agent = await createAgent(t, model);
  const runEnds: number[] = [];
  agent.subscribe((event) => {
    if (event.type === "run_start" && event.runId === 1) {
      agent.abort();
      agent.abort();
    }
    if (event.type === "run_end") runEnds.push(event.runId);
  });

  const cancelled = await agent.prompt("cancel");
  assert.equal(cancelled.reason, "aborted");
  assert.equal(model.requests.length, 0);
  assert.deepEqual(runEnds, [1]);
  assert.equal(agent.getState().status, "idle");

  const second = await agent.prompt("continue");
  assert.equal(second.reason, "stop");
  assert.equal(model.requests.length, 1);
  assert.deepEqual(runEnds, [1, 2]);
});

test("Lab 9.4 · 运行中取消把同一 signal 交给 model 与 tool，并等待配对结果", async (t) => {
  const call = toolCall("slow-tool");
  const scripted = new ScriptedModel([
    assistantMessage([call], "toolUse"),
    assistantMessage([text("new run")]),
  ]);
  const model = new SignalCapturingModel(scripted);
  const toolStarted = deferred<void>();
  let toolSignal: AbortSignal | undefined;
  const executor: ToolExecutor = async (currentCall, context) => {
    if (!context) throw new Error("tool context 缺失");
    toolSignal = context.signal;
    toolStarted.resolve();
    return new Promise<ToolResultMessage>((resolve) => {
      const finish = () =>
        resolve(toolResult(currentCall, "cancelled", true));
      if (context.signal?.aborted) finish();
      else context.signal?.addEventListener("abort", finish, { once: true });
    });
  };
  const agent = await createAgent(t, model, { toolExecutor: executor });

  const running = agent.prompt("run tool");
  await toolStarted.promise;
  agent.abort();
  agent.abort();
  const cancelled = await running;
  assert.equal(cancelled.reason, "aborted");
  assert.equal(model.inner.requests.length, 1);
  assert.equal(model.signals[0], toolSignal);
  assert.equal(toolSignal?.aborted, true);
  assert.deepEqual(
    cancelled.messages.map((message) => message.role),
    ["user", "assistant", "toolResult"],
  );

  const oldSignal = model.signals[0];
  assert.equal((await agent.prompt("new run")).reason, "stop");
  assert.notEqual(model.signals[1], oldSignal);
  assert.equal(model.signals[1]?.aborted, false);

  const ignoresAbort = new ManualModel(false);
  const textAgent = await createAgent(t, ignoresAbort);
  const textRun = textAgent.prompt("cancel text");
  textAgent.abort();
  ignoresAbort.complete(0, assistantMessage([text("late text")]));
  const cancelledText = await textRun;
  assert.equal(cancelledText.reason, "aborted");
  assert.equal(ignoresAbort.requests.length, 1);
});

test("Lab 9.5 · 工具批次完整配对后，steering 按 FIFO 进入下一次请求", async (t) => {
  const slow = toolCall("slow");
  const fast = toolCall("fast");
  const model = new ScriptedModel([
    assistantMessage([slow, fast], "toolUse"),
    assistantMessage([text("steering applied")]),
  ]);
  const starts = new Map<string, Deferred<void>>([
    ["slow", deferred<void>()],
    ["fast", deferred<void>()],
  ]);
  const releases = new Map<string, Deferred<void>>([
    ["slow", deferred<void>()],
    ["fast", deferred<void>()],
  ]);
  const executor: ToolExecutor = async (call) => {
    starts.get(call.id)?.resolve();
    await releases.get(call.id)?.promise;
    return toolResult(call, `${call.id} done`);
  };
  const agent = await createAgent(t, model, { toolExecutor: executor });

  const running = agent.prompt("start batch");
  await Promise.all([
    starts.get("slow")?.promise,
    starts.get("fast")?.promise,
  ]);
  agent.steer("先检查测试");
  agent.steer("再更新说明");
  releases.get("fast")?.resolve();
  await Promise.resolve();
  releases.get("slow")?.resolve();

  const result = await running;
  assert.equal(result.reason, "stop");
  assert.equal(model.requests.length, 2);
  const secondRequest = model.requests[1].messages;
  assert.deepEqual(
    secondRequest.map((message) => message.role),
    ["user", "assistant", "toolResult", "toolResult", "user", "user"],
  );
  assert.deepEqual(
    secondRequest.slice(-2).map(textOf),
    ["先检查测试", "再更新说明"],
  );
  assert.deepEqual(
    secondRequest
      .filter(
        (message): message is ToolResultMessage =>
          message.role === "toolResult",
      )
      .map((message) => message.toolCallId),
    ["slow", "fast"],
  );
});

test("Lab 9.5 · 纯文本 stop 期间到达的 steering 会开启下一轮模型请求", async (t) => {
  const model = new ManualModel();
  const agent = await createAgent(t, model);

  const running = agent.prompt("start");
  assert.equal(model.streams.length, 1);
  agent.steer("回答前补充检查");
  model.complete(0, assistantMessage([text("draft")]));
  await waitUntil(() => model.streams.length === 2);
  model.complete(1, assistantMessage([text("final")]));

  const result = await running;
  assert.equal(result.reason, "stop");
  assert.equal(model.requests.length, 2);
  assert.deepEqual(
    model.requests[1].messages.map((message) => message.role),
    ["user", "assistant", "user"],
  );
  assert.equal(textOf(model.requests[1].messages.at(-1)!), "回答前补充检查");

  const ignoresAbort = new ManualModel(false);
  const abortAgent = await createAgent(t, ignoresAbort);
  const cancelledRun = abortAgent.prompt("cancel before text stop");
  abortAgent.steer("must not consume before abort");
  abortAgent.abort();
  ignoresAbort.complete(0, assistantMessage([text("late draft")]));
  const cancelled = await cancelledRun;
  assert.equal(cancelled.reason, "aborted");
  assert.doesNotMatch(
    cancelled.messages.map(textOf).join("\n"),
    /must not consume/,
  );

  const cleanRun = abortAgent.prompt("clean retry");
  ignoresAbort.complete(1, assistantMessage([text("clean")]));
  assert.equal((await cleanRun).reason, "stop");
  assert.doesNotMatch(
    ignoresAbort.requests[1].messages.map(textOf).join("\n"),
    /must not consume/,
  );
});

test("Lab 9.5 · follow-up 只在自然 stop 后消费，失败队列不会泄漏到下一次 run", async (t) => {
  const naturalModel = new ScriptedModel([
    assistantMessage([text("first")]),
    assistantMessage([text("after follow-up")]),
  ]);
  const natural = await createAgent(t, naturalModel);
  assert.throws(() => natural.steer("idle"), /只在当前 run/);
  assert.throws(() => natural.followUp("idle"), /只在当前 run/);
  let acceptedTerminalSteering = false;
  let acceptedTerminalFollowUp = false;
  let terminalSteeringError = "";
  let terminalFollowUpError = "";
  natural.subscribe((event) => {
    if (event.type === "run_start") {
      natural.followUp("先总结");
      natural.followUp("再列风险");
    }
    if (event.type === "loop" && event.event.type === "turn_end") {
      try {
        natural.steer("too late");
        acceptedTerminalSteering = true;
      } catch (error) {
        terminalSteeringError =
          error instanceof Error ? error.message : String(error);
      }
      try {
        natural.followUp("too late");
        acceptedTerminalFollowUp = true;
      } catch (error) {
        terminalFollowUpError =
          error instanceof Error ? error.message : String(error);
      }
    }
  });
  const naturalResult = await natural.prompt("start");
  assert.equal(naturalResult.reason, "stop");
  assert.equal(acceptedTerminalSteering, false);
  assert.equal(acceptedTerminalFollowUp, false);
  assert.match(terminalSteeringError, /尚未结束/);
  assert.match(terminalFollowUpError, /尚未结束/);
  assert.deepEqual(
    naturalModel.requests[1].messages.map((message) => message.role),
    ["user", "assistant", "user", "user"],
  );
  assert.deepEqual(
    naturalModel.requests[1].messages.slice(-2).map(textOf),
    ["先总结", "再列风险"],
  );

  const errorModel = new ScriptedModel([
    {
      stopReason: "error",
      errorMessage: "provider failed",
    },
    assistantMessage([text("clean next run")]),
  ]);
  const afterError = await createAgent(t, errorModel);
  afterError.subscribe((event) => {
    if (event.type === "run_start" && event.runId === 1) {
      afterError.steer("must not leak steering");
      afterError.followUp("must not leak follow-up");
    }
  });
  assert.equal((await afterError.prompt("fail")).reason, "error");
  assert.equal((await afterError.prompt("retry")).reason, "stop");
  assert.equal(errorModel.requests.length, 2);
  assert.doesNotMatch(
    errorModel.requests[1].messages.map(textOf).join("\n"),
    /must not leak/,
  );

  const abortCall = toolCall("abort-queue");
  const abortModel = new ScriptedModel([
    assistantMessage([abortCall], "toolUse"),
    assistantMessage([text("clean after abort")]),
  ]);
  const abortToolStarted = deferred<void>();
  const abortAgent = await createAgent(t, abortModel, {
    toolExecutor: async (call, context) => {
      abortToolStarted.resolve();
      await new Promise<void>((resolve) => {
        if (context?.signal?.aborted) resolve();
        else context?.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      return toolResult(call, "cancelled", true);
    },
  });
  const abortRun = abortAgent.prompt("cancel tool");
  await abortToolStarted.promise;
  abortAgent.steer("must not consume after tool");
  abortAgent.abort();
  const aborted = await abortRun;
  assert.equal(aborted.reason, "aborted");
  assert.doesNotMatch(
    aborted.messages.map(textOf).join("\n"),
    /must not consume/,
  );
  assert.equal((await abortAgent.prompt("retry after abort")).reason, "stop");
  assert.doesNotMatch(
    abortModel.requests[1].messages.map(textOf).join("\n"),
    /must not consume/,
  );
});
