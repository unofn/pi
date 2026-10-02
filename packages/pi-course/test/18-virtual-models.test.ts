import assert from "node:assert/strict";
import test from "node:test";
import {
  requestReason,
  runAgentLoop,
  type AgentRequest,
} from "../src/agent-loop.js";
import {
  createRuntime,
  type RuntimeConfig,
  type RuntimeDeps,
  type RuntimeRequestSession,
} from "../src/composition.js";
import type { ResourceCatalog } from "../src/resources.js";
import { ScriptedModel, type ScriptedTurn } from "../src/scripted-model.js";
import type {
  JsonValue,
  MetadataSessionEntry,
  SessionEntry,
  SessionStore,
} from "../src/session.js";
import { objectSchema, stringValue, ToolRegistry, type Tool } from "../src/tool.js";
import {
  assistantMessage,
  text,
  userMessage,
  type AgentContext,
  type AgentMessage,
  type Model,
  type ModelStreamOptions,
  type ThinkingLevel,
  type ToolCall,
} from "../src/types.js";
import {
  branchSelection,
  createVirtualModelRouting,
  findLatestResponse,
  MODEL_CHANGE_KEY,
  ModelCatalog,
  resolveRoute,
  selectModel,
  VIRTUAL_MODEL_STATE_KEY,
  virtualModelState,
  type ModelRouteRequest,
  type VirtualModel,
} from "../src/virtual-models.js";

function reply(model: string, value: string, stopReason: "stop" | "toolUse" = "stop", calls: ToolCall[] = []) {
  return assistantMessage([text(value), ...calls], stopReason, { model, provider: "test" });
}

function scripted(model: string, turns: ScriptedTurn[]): ScriptedModel {
  return new ScriptedModel(
    turns.map((turn) => ("role" in turn ? { ...turn, model, provider: "test" } : turn)),
  );
}

/** 记录每次 stream 收到的 options 的模型。 */
class RecordingModel implements Model {
  readonly options: ModelStreamOptions[] = [];
  constructor(private readonly inner: ScriptedModel) {}
  stream(context: AgentContext, options: ModelStreamOptions = {}) {
    this.options.push({ ...options });
    return this.inner.stream(context, options);
  }
}

const echo: Tool<{ value: string }> = {
  name: "echo",
  description: "echo",
  schema: objectSchema({ value: stringValue }),
  async execute({ value }) {
    return { content: [text(value)] };
  },
};

function call(id: string, value: string): ToolCall {
  return { type: "toolCall", id, name: "echo", arguments: { value } };
}

function metadata(id: string, parentId: string | null, key: string, value: JsonValue): MetadataSessionEntry {
  return { id, parentId, timestamp: 1, type: "metadata", key, value };
}

interface FakeSession extends RuntimeRequestSession {
  entries: SessionEntry[];
  records: { key: string; value: JsonValue }[];
}

function fakeSession(entries: SessionEntry[] = []): FakeSession {
  const session: FakeSession = {
    entries,
    records: [],
    branch: () => [...session.entries],
    record: (key, value) => {
      session.records.push({ key, value });
      session.entries.push(metadata(`m${session.entries.length}`, null, key, value));
    },
  };
  return session;
}

test("Lab 18.1 · 目录区分物理模型与虚拟模型：同一个 id 不能同时是两者，provider 只拿得到物理模型", () => {
  const catalog = new ModelCatalog();
  const fast = scripted("fast-v1", []);
  catalog.registerPhysical("fast", fast);
  catalog.registerVirtual({ id: "auto", route: () => ({ model: "fast" }) });

  assert.deepEqual(catalog.physical("fast"), { id: "fast", model: fast });
  assert.equal(catalog.physical("auto"), undefined);
  assert.equal(catalog.isVirtual("auto"), true);
  assert.equal(catalog.isVirtual("fast"), false);
  assert.equal(catalog.has("auto"), true);
  assert.equal(catalog.has("missing"), false);
  assert.throws(() => catalog.registerVirtual({ id: "fast", route: () => ({ model: "fast" }) }), /已经是物理模型/);
  assert.throws(() => catalog.registerPhysical("auto", fast), /已经是虚拟模型/);
  assert.throws(() => catalog.registerPhysical(" ", fast), /不能为空/);
});

test("Lab 18.1 · previous 只看最近一次成功回复：error 与 aborted 的回复被跳过", () => {
  const good = reply("fast-v1", "ok");
  const messages: AgentMessage[] = [
    userMessage("a"),
    good,
    userMessage("b"),
    assistantMessage([], "error", { errorMessage: "boom", model: "smart-v1" }),
    assistantMessage([], "aborted", { errorMessage: "stop", model: "smart-v1" }),
  ];
  assert.equal(findLatestResponse(messages), good);
  assert.equal(findLatestResponse([userMessage("only")]), undefined);
  const latestTool = reply("smart-v1", "calling", "toolUse", [call("c1", "x")]);
  assert.equal(findLatestResponse([...messages, latestTool]), latestTool);
});

test("Lab 18.1 · resolveRoute 把虚拟选择换成物理模型并转达 previous / failed / state；路由到虚拟模型、未注册或 route 抛错都失败", async () => {
  const catalog = new ModelCatalog();
  const fast = scripted("fast-v1", []);
  const smart = scripted("smart-v1", []);
  catalog.registerPhysical("fast-v1", fast);
  catalog.registerPhysical("smart-v1", smart);
  const seen: ModelRouteRequest<{ turns: number }>[] = [];
  catalog.registerVirtual<{ turns: number }>({
    id: "auto",
    route(request) {
      seen.push(request);
      const turns = (request.state?.turns ?? 0) + 1;
      return { model: turns > 1 ? "smart-v1" : "fast-v1", thinkingLevel: "low", state: { turns } };
    },
  });
  catalog.registerVirtual({ id: "loop", route: () => ({ model: "auto" }) });
  catalog.registerVirtual({ id: "ghost", route: () => ({ model: "nope" }) });
  catalog.registerVirtual({
    id: "broken",
    route: () => {
      throw new Error("router exploded");
    },
  });

  const failed = assistantMessage([], "error", { errorMessage: "x", model: "fast-v1" });
  const messages = [userMessage("hi"), reply("fast-v1", "ok"), userMessage("more")];
  const first = await resolveRoute(catalog, "auto", { reason: "user", messages });
  assert.deepEqual(first, { model: { id: "fast-v1", model: fast }, thinkingLevel: "low", state: { turns: 1 } });
  assert.deepEqual(seen[0], {
    model: { id: "auto" },
    reason: "user",
    previous: { model: { id: "fast-v1", model: fast } },
    messages,
  });

  const second = await resolveRoute(catalog, "auto", {
    reason: "retry",
    messages: [userMessage("hi")],
    failed,
    state: { turns: 1 },
  });
  assert.equal(second.model.id, "smart-v1");
  assert.deepEqual(seen[1]!.failed, { model: { id: "fast-v1", model: fast }, message: failed });
  assert.equal(seen[1]!.previous, undefined);
  assert.deepEqual(seen[1]!.state, { turns: 1 });

  await assert.rejects(resolveRoute(catalog, "loop", { reason: "user", messages }), /routed to auto, which is another virtual model/);
  await assert.rejects(resolveRoute(catalog, "ghost", { reason: "user", messages }), /routed to nope, which is not a physical model/);
  await assert.rejects(resolveRoute(catalog, "missing", { reason: "user", messages }), /Virtual model missing is not registered/);
  await assert.rejects(resolveRoute(catalog, "broken", { reason: "user", messages }), /router exploded/);
});

test("Lab 18.2 · loop 在每次请求前调用 prepareRequest：第一次是 user，工具结果之后是 continuation；只有钩子换入的物理模型收到请求", async () => {
  const configured = scripted("configured-v1", [reply("configured-v1", "never")]);
  const fast = scripted("fast-v1", [
    reply("fast-v1", "calling", "toolUse", [call("c1", "x")]),
    reply("fast-v1", "done"),
  ]);
  const requests: AgentRequest[] = [];
  const result = await runAgentLoop({
    model: configured,
    tools: new ToolRegistry([echo]),
    context: { messages: [userMessage("go")] },
    prepareRequest(request) {
      requests.push(structuredClone(request));
      assert.equal(request.model, configured);
      return { model: fast };
    },
  });

  assert.equal(result.reason, "stop");
  assert.deepEqual(requests.map((request) => request.reason), ["user", "continuation"]);
  assert.equal(requests[1]!.context.messages.length, 3);
  assert.deepEqual(requests[1]!.context.tools?.map((tool) => tool.name), ["echo"]);
  assert.equal(configured.requests.length, 0);
  assert.equal(fast.requests.length, 2);
  assert.deepEqual(
    result.messages.flatMap((message) => (message.role === "assistant" ? [message.model] : [])),
    ["fast-v1", "fast-v1"],
  );
});

test("Lab 18.2 · 直接重跑以失败回复结尾的 transcript 时 reason 为 retry 并带 failed（只有直接调用 loop 才会出现）；钩子抛错以 error 回复结束本次请求", async () => {
  const failed = assistantMessage([], "error", { errorMessage: "rate limited", model: "fast-v1" });
  assert.deepEqual(requestReason([userMessage("go"), failed]), { reason: "retry", failed });
  assert.deepEqual(requestReason([userMessage("go")]), { reason: "user" });
  assert.deepEqual(requestReason([userMessage("go"), failed, userMessage("again")]), { reason: "user" });
  assert.deepEqual(requestReason([userMessage("go"), reply("fast-v1", "ok")]), { reason: "continuation" });

  const fast = scripted("fast-v1", [reply("fast-v1", "recovered")]);
  const reasons: string[] = [];
  const retried = await runAgentLoop({
    model: fast,
    tools: new ToolRegistry(),
    context: { messages: [userMessage("go"), failed] },
    prepareRequest(request) {
      reasons.push(`${request.reason}:${request.failed?.errorMessage ?? ""}`);
    },
  });
  assert.deepEqual(reasons, ["retry:rate limited"]);
  assert.equal(retried.reason, "stop");

  const untouched = scripted("fast-v1", [reply("fast-v1", "never")]);
  const broken = await runAgentLoop({
    model: untouched,
    tools: new ToolRegistry(),
    context: { messages: [userMessage("go")] },
    async prepareRequest() {
      throw new Error("Virtual model auto routed to nope, which is not a physical model.");
    },
  });
  assert.equal(broken.reason, "error");
  assert.equal(untouched.requests.length, 0);
  const last = broken.messages.at(-1)!;
  assert.equal(last.role === "assistant" && last.stopReason, "error");
  assert.match(last.role === "assistant" ? last.errorMessage ?? "" : "", /routed to nope/);
  assert.deepEqual(broken.messages.slice(0, -1), [userMessage("go")].map((m) => ({ ...m, timestamp: broken.messages[0]!.timestamp })));
});

test("Lab 18.2 · thinkingLevel 随请求传给物理模型的 stream，钩子看到的 context 就是本次请求，transcript 不被改写", async () => {
  const recording = new RecordingModel(scripted("smart-v1", [reply("smart-v1", "ok")]));
  const controller = new AbortController();
  let seenContext: AgentContext | undefined;
  const messages = [userMessage("go")];
  const result = await runAgentLoop({
    model: scripted("configured-v1", []),
    tools: new ToolRegistry(),
    signal: controller.signal,
    context: { messages },
    prepareRequest(request, signal) {
      // context 就是 loop 的活对象：钩子之后 loop 还会往里追加回复，所以这里拍快照。
      seenContext = structuredClone(request.context);
      assert.equal(signal, controller.signal);
      return { model: recording, thinkingLevel: "high" satisfies ThinkingLevel };
    },
  });
  assert.equal(result.reason, "stop");
  assert.deepEqual(recording.options, [{ signal: controller.signal, thinkingLevel: "high" }]);
  assert.deepEqual(seenContext?.messages, messages);
  assert.deepEqual(result.messages.slice(0, 1), messages);
});

test("Lab 18.3 · 分支上的选择与状态：最后一条 model_change 决定选中模型，状态按模型 id 查最近一条", () => {
  const branch: SessionEntry[] = [
    metadata("m1", null, MODEL_CHANGE_KEY, { modelId: "auto" }),
    metadata("m2", "m1", VIRTUAL_MODEL_STATE_KEY, { modelId: "auto", state: { turns: 1 } }),
    metadata("m3", "m2", VIRTUAL_MODEL_STATE_KEY, { modelId: "other", state: { turns: 9 } }),
    metadata("m4", "m3", "unrelated", { modelId: "nope" }),
    metadata("m5", "m4", MODEL_CHANGE_KEY, { modelId: "fast-v1" }),
    metadata("m6", "m5", VIRTUAL_MODEL_STATE_KEY, { modelId: "auto", state: { turns: 2 } }),
  ];
  assert.equal(branchSelection(branch), "fast-v1");
  assert.equal(branchSelection(branch.slice(0, 4)), "auto");
  assert.equal(branchSelection([]), undefined);
  assert.deepEqual(virtualModelState(branch, "auto"), { turns: 2 });
  assert.deepEqual(virtualModelState(branch, "other"), { turns: 9 });
  assert.equal(virtualModelState(branch, "missing"), undefined);
  assert.equal(branchSelection([metadata("x", null, MODEL_CHANGE_KEY, "auto")]), undefined, "值必须是 { modelId }");
});

test("Lab 18.3 · 路由只在状态变化时记录 virtual_model_state；选中物理模型时直接派发；direct 请求不读不写状态", async () => {
  const catalog = new ModelCatalog();
  const fast = scripted("fast-v1", []);
  const smart = scripted("smart-v1", []);
  catalog.registerPhysical("fast-v1", fast);
  catalog.registerPhysical("smart-v1", smart);
  const states: unknown[] = [];
  catalog.registerVirtual<{ turns: number }>({
    id: "auto",
    route(request) {
      states.push(request.state);
      const turns = request.state?.turns ?? 0;
      return { model: turns >= 1 ? "smart-v1" : "fast-v1", state: { turns: Math.min(turns + 1, 1) } };
    },
  });
  const routing = createVirtualModelRouting(catalog, { defaultModelId: "auto" });
  const session = fakeSession();
  const request = (messages: AgentMessage[]): AgentRequest => ({
    context: { messages },
    model: fast,
    reason: "user",
  });

  const first = await routing.prepareRequest(request([userMessage("a")]), session);
  assert.equal(first.model, fast);
  assert.deepEqual(session.records, [{ key: VIRTUAL_MODEL_STATE_KEY, value: { modelId: "auto", state: { turns: 1 } } }]);
  const second = await routing.prepareRequest(request([userMessage("a"), reply("fast-v1", "ok"), userMessage("b")]), session);
  assert.equal(second.model, smart);
  assert.equal(session.records.length, 1, "状态没变就不再记录");
  assert.deepEqual(states, [undefined, { turns: 1 }]);

  const direct = await routing.routeDirect(session, [userMessage("summary")]);
  assert.equal(direct.model.id, "fast-v1", "direct 不读状态，所以回到第一跳");
  assert.equal(session.records.length, 1, "direct 不写状态");
  assert.equal(states.at(-1), undefined);

  session.entries.push(metadata("m9", null, MODEL_CHANGE_KEY, { modelId: "smart-v1" }));
  const physical = await routing.prepareRequest(request([userMessage("c")]), session);
  assert.equal(physical.model, smart);
  assert.equal(states.length, 3, "选中物理模型时不问路由器");
});

function emptyResources(): ResourceCatalog {
  return { resources: [], instructions: [], skills: [], templates: [] };
}

class RecordingSessionStore implements SessionStore {
  readonly committed: SessionEntry[];
  constructor(initial: SessionEntry[] = []) {
    this.committed = structuredClone(initial);
  }
  async append(entry: SessionEntry): Promise<void> {
    this.committed.push(structuredClone(entry));
  }
  async entries(): Promise<SessionEntry[]> {
    return structuredClone(this.committed);
  }
}

function deps(session: SessionStore, overrides: Partial<RuntimeDeps>): RuntimeDeps {
  let id = 0;
  let now = 100;
  return {
    model: scripted("configured-v1", []),
    tools: new ToolRegistry(),
    session,
    resources: emptyResources(),
    createId: () => `e${++id}`,
    now: () => ++now,
    ...overrides,
  };
}

const CONFIG: RuntimeConfig = {
  activeLeafId: null,
  maxSteps: 4,
  context: { total: 10_000, reservedOutput: 0, safetyMargin: 0, estimateTokens: () => 1 },
};

function routedCatalog(turnsPerModel: Record<string, ScriptedTurn[]>, router?: VirtualModel<{ count: number }>["route"]) {
  const catalog = new ModelCatalog();
  for (const [id, turns] of Object.entries(turnsPerModel)) catalog.registerPhysical(id, scripted(id, turns));
  catalog.registerVirtual<{ count: number }>({
    id: "auto",
    route:
      router ??
      ((request) => {
        const count = (request.state?.count ?? 0) + 1;
        return { model: count % 2 === 1 ? "fast-v1" : "smart-v1", state: { count } };
      }),
  });
  return catalog;
}

test("Lab 18.3 · 经 Runtime：model_change 与路由状态都是分支上的 metadata entry，状态跟在本轮消息之后落盘，重新打开后从 active path 还原选择与状态", async () => {
  const catalog = routedCatalog({
    "fast-v1": [reply("fast-v1", "one"), reply("fast-v1", "three")],
    "smart-v1": [reply("smart-v1", "two")],
  });
  const routing = createVirtualModelRouting(catalog, { defaultModelId: "fast-v1" });
  const store = new RecordingSessionStore();
  const runtime = await createRuntime(CONFIG, deps(store, { prepareRequest: routing.prepareRequest }));
  await selectModel(runtime, catalog, "auto");
  await assert.rejects(selectModel(runtime, catalog, "missing"), /未注册/);
  const first = await runtime.prompt("first");
  const second = await runtime.prompt("second");
  await runtime.dispose();

  const modelOf = (result: { messages: AgentMessage[] }) =>
    result.messages.flatMap((message) => (message.role === "assistant" ? [message.model] : []));
  assert.deepEqual(modelOf(first), ["fast-v1"]);
  assert.deepEqual(modelOf(second), ["fast-v1", "smart-v1"]);
  assert.deepEqual(
    store.committed.map((entry) => (entry.type === "metadata" ? `${entry.key}:${JSON.stringify(entry.value)}` : `${entry.type}:${entry.type === "message" ? entry.message.role : ""}`)),
    [
      `model_change:{"modelId":"auto"}`,
      "message:user",
      "message:assistant",
      `virtual_model_state:{"modelId":"auto","state":{"count":1}}`,
      "message:user",
      "message:assistant",
      `virtual_model_state:{"modelId":"auto","state":{"count":2}}`,
    ],
  );
  assert.deepEqual(store.committed.map((entry) => entry.parentId), [null, "e1", "e2", "e3", "e4", "e5", "e6"]);

  let nextId = 7;
  let nextNow = 107;
  const reopened = await createRuntime(
    { ...CONFIG, activeLeafId: "e7" },
    deps(store, {
      prepareRequest: createVirtualModelRouting(
        routedCatalog({ "fast-v1": [reply("fast-v1", "three")], "smart-v1": [] }),
        { defaultModelId: "fast-v1" },
      ).prepareRequest,
      createId: () => `e${++nextId}`,
      now: () => ++nextNow,
    }),
  );
  const third = await reopened.prompt("third");
  await reopened.dispose();
  assert.deepEqual(modelOf(third), ["fast-v1", "smart-v1", "fast-v1"], "恢复出 count=2，第三次路由回到 fast");
  assert.deepEqual(store.committed.at(-1), {
    id: "e10",
    parentId: "e9",
    timestamp: 110,
    type: "metadata",
    key: VIRTUAL_MODEL_STATE_KEY,
    value: { modelId: "auto", state: { count: 3 } },
  });
});

test("Lab 18.3 · 路由失败时本轮以 error 回复结束且不写状态；下一轮仍从分支上的选择重新路由", async () => {
  let attempts = 0;
  const catalog = routedCatalog({ "fast-v1": [reply("fast-v1", "ok")], "smart-v1": [] }, () => {
    attempts += 1;
    if (attempts === 1) throw new Error("router exploded");
    return { model: "fast-v1", state: { count: attempts } };
  });
  const routing = createVirtualModelRouting(catalog, { defaultModelId: "auto" });
  const store = new RecordingSessionStore();
  const runtime = await createRuntime(CONFIG, deps(store, { prepareRequest: routing.prepareRequest }));
  const failed = await runtime.prompt("first");
  assert.equal(failed.reason, "error");
  const last = failed.messages.at(-1)!;
  assert.match(last.role === "assistant" ? last.errorMessage ?? "" : "", /router exploded/);
  assert.deepEqual(
    store.committed.map((entry) => entry.type),
    ["message", "message"],
  );

  const recovered = await runtime.prompt("second");
  assert.equal(recovered.reason, "stop");
  assert.equal(store.committed.filter((entry) => entry.type === "metadata").length, 1);
  assert.equal(attempts, 2);
  await runtime.dispose();
});
