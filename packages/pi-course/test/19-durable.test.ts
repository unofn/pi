import assert from "node:assert/strict";
import test from "node:test";
import {
  DurableHarness,
  DurableSession,
  DurableStore,
  StorageRejected,
  type DurableSnapshot,
  type DurableWrite,
  type TaskRecord,
} from "../src/durable.js";
import { AssistantMessageEventStream } from "../src/event-stream.js";
import { ScriptedModel } from "../src/scripted-model.js";
import type { JsonValue } from "../src/session.js";
import { objectSchema, stringValue, type Tool } from "../src/tool.js";
import {
  assistantMessage,
  text,
  type AgentContext,
  type AssistantMessage,
  type Model,
  type ToolCall,
} from "../src/types.js";

const SLOW = { timeout: 5_000 };

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

function write(collection: "entries" | "tasks", id: string, value: JsonValue): DurableWrite {
  return { collection, id, value };
}

function call(id: string, value: string): ToolCall {
  return { type: "toolCall", id, name: "echo", arguments: { value } };
}

interface CountingTool extends Tool<{ value: string }> {
  runs: number;
  /** 第 n 次执行时挂起（0 表示从不挂起）。 */
  hangOn: number;
  started: Deferred<void>;
}

function countingTool(hangOn = 0): CountingTool {
  const tool: CountingTool = {
    name: "echo",
    description: "echo",
    schema: objectSchema({ value: stringValue }),
    runs: 0,
    hangOn,
    started: deferred<void>(),
    execute({ value }, context) {
      tool.runs += 1;
      tool.started.resolve();
      if (tool.runs === tool.hangOn) {
        // 挂起直到被取消：模拟进程在这里崩溃。
        return new Promise((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => reject(new Error("crashed")), { once: true });
        });
      }
      return Promise.resolve({ content: [text(`echo:${value}`)] });
    },
  };
  return tool;
}

function ids(prefix = "id"): () => string {
  let next = 0;
  return () => `${prefix}${++next}`;
}

/** 记录每次提交触及的任务状态，并在第 N 次提交后拍快照。 */
function observe(store: DurableStore, snapshotAt?: number) {
  const log: string[] = [];
  let snapshot: DurableSnapshot | undefined;
  store.onCommit((seq, writes) => {
    for (const entry of writes) {
      if (entry.collection === "tasks") {
        const task = entry.value as unknown as TaskRecord;
        log.push(`${seq}:${task.kind}:${task.status}:${task.checkpoint.phase}`);
      } else {
        const record = entry.value as { entry: { type: string } };
        log.push(`${seq}:entry:${record.entry.type}`);
      }
    }
    if (seq === snapshotAt) snapshot = store.snapshot();
  });
  return { log, snapshot: () => snapshot };
}

/** 手动推进的流式模型：先给几段增量，再按需挂起或完成。 */
function manualModel(deltas: string[], final?: AssistantMessage) {
  const requests: AgentContext[] = [];
  const streams: AssistantMessageEventStream[] = [];
  const model: Model = {
    stream(context) {
      requests.push(structuredClone(context));
      const stream = new AssistantMessageEventStream();
      streams.push(stream);
      queueMicrotask(() => {
        const partial = assistantMessage([], "stop");
        stream.push({ type: "start", partial: structuredClone(partial) });
        let accumulated = "";
        deltas.forEach((delta, index) => {
          accumulated += delta;
          partial.content = [text(accumulated)];
          stream.push({ type: "text_delta", contentIndex: 0, delta, partial: structuredClone(partial) });
          void index;
        });
        if (final) {
          stream.push({ type: "done", reason: "stop", message: final });
          stream.end(final);
        }
      });
      return stream;
    },
  };
  return { model, requests, streams };
}

test("Lab 19.1 · 原子批量提交：一批写入要么全部进入存储，要么一个都不进；快照导出再导入得到相同状态", async () => {
  const store = new DurableStore();
  const seq = await store.commit([
    write("entries", "e1", { index: 0 }),
    write("tasks", "t1", { status: "pending" }),
  ]);
  assert.equal(seq, 1);
  assert.deepEqual(store.get("entries", "e1"), { index: 0 });

  await assert.rejects(
    store.commit([
      write("entries", "e2", { index: 1 }),
      { collection: "tasks", id: "t2", value: { bad: Number.NaN } as unknown as JsonValue },
    ]),
    StorageRejected,
  );
  assert.equal(store.get("entries", "e2"), undefined, "同批里合法的写入也不能落下");
  assert.equal(store.currentSeq, 1);

  await store.commit([write("entries", "e1", { index: 0, replaced: true })]);
  assert.deepEqual(store.get("entries", "e1"), { index: 0, replaced: true }, "按 id 整条替换");
  const snapshot = store.snapshot();
  assert.deepEqual(snapshot, {
    seq: 2,
    entries: { e1: { index: 0, replaced: true } },
    tasks: { t1: { status: "pending" } },
  });
  const restored = DurableStore.fromSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(restored.snapshot(), snapshot);
  assert.equal(await restored.commit([write("tasks", "t2", {})]), 3);
  assert.equal(store.currentSeq, 2, "快照是副本，不是共享状态");
});

test("Lab 19.1 · 单一变更线：并发 commit 串行执行，change 里读到的是前一次提交后的状态", async () => {
  const session = new DurableSession(new DurableStore());
  const order: string[] = [];
  const gate = deferred<void>();
  const first = session.commit(async (tx) => {
    order.push("first:start");
    await gate.promise;
    tx.put("entries", "e1", { n: 1 });
    order.push("first:end");
    return "first";
  });
  const second = session.commit((tx) => {
    order.push(`second:sees:${JSON.stringify(tx.get("entries", "e1"))}`);
    tx.put("entries", "e2", { n: 2 });
    return "second";
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(order, ["first:start"], "第二个 change 必须等第一个提交完成");
  assert.equal(session.get("entries", "e1"), undefined, "提交前不可见");
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(order, ["first:start", "first:end", 'second:sees:{"n":1}']);
  assert.deepEqual(session.list("entries").map((item) => item.id), ["e1", "e2"]);
});

test("Lab 19.1 · 先提交再可见：change 抛错或存储拒绝时没有任何可见进展；失败的提交不阻塞后面的提交", async () => {
  const store = new DurableStore();
  const session = new DurableSession(store);
  const commits: number[] = [];
  store.onCommit((seq) => commits.push(seq));

  await assert.rejects(
    session.commit((tx) => {
      tx.put("entries", "e1", { n: 1 });
      throw new Error("change failed");
    }),
    /change failed/,
  );
  await assert.rejects(
    session.commit((tx) => {
      tx.put("entries", "e1", { n: 1 });
      tx.put("tasks", "t1", { bad: () => undefined } as unknown as JsonValue);
    }),
    StorageRejected,
  );
  assert.deepEqual(session.list("entries"), []);
  assert.deepEqual(store.list("entries"), []);
  assert.deepEqual(commits, []);

  await session.commit((tx) => tx.put("entries", "e1", { n: 1 }));
  assert.deepEqual(commits, [1]);
  assert.deepEqual(session.get("entries", "e1"), { n: 1 });
  assert.equal(await session.commit(() => "read only"), "read only");
  assert.deepEqual(commits, [1], "没有写入的 change 不产生提交");
});

test("Lab 19.2 · prompt 把用户 entry 与 generation 任务放进同一次提交；run 让任务 pending → running → completed，检查点整条替换", SLOW, async () => {
  const store = new DurableStore();
  const { log } = observe(store);
  const harness = await DurableHarness.open({
    store,
    model: new ScriptedModel([assistantMessage([text("hello")])]),
    createId: ids(),
  });
  await harness.prompt("c1", "hi");
  assert.deepEqual(log, ["1:entry:user", "1:generation:pending:request"]);
  assert.deepEqual(harness.tasks().map((task) => task.status), ["pending"]);

  await harness.run();
  assert.deepEqual(log, [
    "1:entry:user",
    "1:generation:pending:request",
    "2:generation:running:request",
    "3:generation:running:request",
    "4:entry:assistant",
    "4:generation:completed:request",
  ]);
  assert.deepEqual(
    harness.messages("c1").map((message) => message.role),
    ["user", "assistant"],
  );
  assert.deepEqual(harness.tasks().map((task) => task.status), ["completed"]);
  assert.deepEqual(harness.tasks()[0]!.checkpoint, { phase: "request" }, "完成后检查点不再带 partial");
  await harness.run();
  assert.equal(store.currentSeq, 4, "没有 pending 任务时 run 不提交");
});

test("Lab 19.2 · 重新打开时 running 的任务改回 pending，其余任务不变", SLOW, async () => {
  const store = new DurableStore();
  const { log } = observe(store);
  const harness = await DurableHarness.open({
    store,
    model: new ScriptedModel([assistantMessage([text("one")]), assistantMessage([text("never")])]),
    createId: ids(),
  });
  await harness.prompt("c1", "first");
  await harness.run();
  await harness.prompt("c1", "second");
  const controller = new AbortController();
  store.onCommit((seq) => {
    if (seq === 6) controller.abort();
  });
  await harness.run({ signal: controller.signal });
  const crashed = store.snapshot();
  assert.deepEqual(
    harness.tasks().map((task) => task.status),
    ["completed", "running"],
    `崩溃点的状态：${log.join(" ")}`,
  );

  const reopened = await DurableHarness.open({
    store: DurableStore.fromSnapshot(crashed),
    model: new ScriptedModel([assistantMessage([text("two")])]),
    createId: ids("r"),
  });
  assert.deepEqual(reopened.tasks().map((task) => task.status), ["completed", "pending"]);
  await reopened.run();
  assert.deepEqual(reopened.tasks().map((task) => task.status), ["completed", "completed"]);
  assert.deepEqual(
    reopened.messages("c1").map((message) => (message.role === "assistant" ? message.content : message.role)),
    ["user", [text("one")], "user", [text("two")]],
  );
});

test("Lab 19.3 · 工具任务在 execute() 之前提交意图（参数与 replay 策略），结果与下一轮 generation 在意图之后同一次提交里可见", SLOW, async () => {
  const store = new DurableStore();
  const { log } = observe(store);
  const tool = countingTool();
  const harness = await DurableHarness.open({
    store,
    model: new ScriptedModel([
      assistantMessage([text("calling"), call("c1", "x")], "toolUse"),
      assistantMessage([text("done")]),
    ]),
    tools: [{ tool, replay: "safe" }],
    createId: ids(),
  });
  await harness.prompt("c1", "go");
  await harness.run();

  assert.deepEqual(log, [
    "1:entry:user",
    "1:generation:pending:request",
    "2:generation:running:request",
    "3:generation:running:request",
    "4:entry:assistant",
    "4:tool:pending:call",
    "4:generation:completed:request",
    "5:tool:running:call",
    "6:tool:running:execute",
    "7:entry:toolResult",
    "7:tool:completed:execute",
    "7:generation:pending:request",
    "8:generation:running:request",
    "9:generation:running:request",
    "10:entry:assistant",
    "10:generation:completed:request",
  ]);
  assert.equal(tool.runs, 1);
  const toolTask = harness.tasks()[1]!;
  assert.deepEqual(toolTask.checkpoint, { phase: "execute", arguments: { value: "x" }, replay: "safe" });
  assert.deepEqual(
    harness.messages("c1").map((message) => message.role),
    ["user", "assistant", "toolResult", "assistant"],
  );
  const result = harness.messages("c1")[2]!;
  assert.equal(result.role === "toolResult" && result.content[0]!.text, "echo:x");
});

test("Lab 19.3 · 恢复时存储意图与当前注册都是 replay:safe 才重跑：安全工具从头重跑一次，结果正常", SLOW, async () => {
  const store = new DurableStore();
  const hanging = countingTool(1);
  const harness = await DurableHarness.open({
    store,
    model: new ScriptedModel([assistantMessage([call("c1", "x")], "toolUse")]),
    tools: [{ tool: hanging, replay: "safe" }],
    createId: ids(),
  });
  await harness.prompt("c1", "go");
  const controller = new AbortController();
  const running = harness.run({ signal: controller.signal });
  await hanging.started.promise;
  assert.deepEqual(harness.tasks()[1]!.checkpoint, { phase: "execute", arguments: { value: "x" }, replay: "safe" }, "意图在 execute 之前已可见");
  assert.equal(harness.messages("c1").length, 2, "结果尚未可见");
  controller.abort();
  await running;
  const crashed = store.snapshot();

  const rerun = countingTool();
  const reopened = await DurableHarness.open({
    store: DurableStore.fromSnapshot(crashed),
    model: new ScriptedModel([assistantMessage([text("done")])]),
    tools: [{ tool: rerun, replay: "safe" }],
    createId: ids("r"),
  });
  assert.equal(reopened.tasks()[1]!.status, "pending");
  await reopened.run();
  assert.equal(rerun.runs, 1, "重跑一次");
  assert.deepEqual(reopened.tasks().map((task) => task.status), ["completed", "completed", "completed"]);
  const result = reopened.messages("c1")[2]!;
  assert.equal(result.role === "toolResult" && result.isError, false);
  assert.equal(result.role === "toolResult" && result.content[0]!.text, "echo:x");
});

test("Lab 19.3 · 存储意图是 unsafe，或当前注册改成 unsafe，恢复都给模型 interrupted 错误结果而不重跑", SLOW, async () => {
  async function crashAfterIntent(replay: "safe" | "unsafe") {
    const store = new DurableStore();
    const hanging = countingTool(1);
    const harness = await DurableHarness.open({
      store,
      model: new ScriptedModel([assistantMessage([call("c1", "x")], "toolUse")]),
      tools: [{ tool: hanging, replay }],
      createId: ids(),
    });
    await harness.prompt("c1", "go");
    const controller = new AbortController();
    const running = harness.run({ signal: controller.signal });
    await hanging.started.promise;
    controller.abort();
    await running;
    return store.snapshot();
  }

  for (const [stored, current] of [
    ["unsafe", "safe"],
    ["safe", "unsafe"],
    ["unsafe", "unsafe"],
  ] as const) {
    const rerun = countingTool();
    const reopened = await DurableHarness.open({
      store: DurableStore.fromSnapshot(await crashAfterIntent(stored)),
      model: new ScriptedModel([assistantMessage([text("after interruption")])]),
      tools: [{ tool: rerun, replay: current }],
      createId: ids("r"),
    });
    await reopened.run();
    assert.equal(rerun.runs, 0, `${stored}/${current} 不该重跑`);
    const toolTask = reopened.tasks()[1]!;
    assert.equal(toolTask.status, "failed");
    assert.match(toolTask.error ?? "", /interrupted/);
    const result = reopened.messages("c1")[2]!;
    assert.equal(result.role, "toolResult");
    if (result.role === "toolResult") {
      assert.equal(result.isError, true);
      assert.equal(result.toolCallId, "c1");
      assert.deepEqual(result.details, {
        error: "interrupted",
        message: "Tool echo was interrupted and may have partially run",
      });
    }
    assert.deepEqual(
      reopened.messages("c1").map((message) => message.role),
      ["user", "assistant", "toolResult", "assistant"],
      "模型拿到 interrupted 结果后继续下一轮",
    );
  }
});

test("Lab 19.4 · 流式部分输出逐步提交；崩溃后已提交的部分输出变成 aborted assistant entry，请求用同样的消息从头重发", SLOW, async () => {
  const store = new DurableStore();
  const { log } = observe(store);
  const hanging = manualModel(["Hel", "lo"]);
  const harness = await DurableHarness.open({
    store,
    model: hanging.model,
    createId: ids(),
  });
  await harness.prompt("c1", "say hello");
  const controller = new AbortController();
  store.onCommit((seq) => {
    if (seq === 4) controller.abort();
  });
  await harness.run({ signal: controller.signal });
  assert.deepEqual(log.slice(2), [
    "2:generation:running:request",
    "3:generation:running:request",
    "4:generation:running:request",
  ]);
  const crashedTask = harness.tasks()[0]!;
  assert.equal(crashedTask.kind === "generation" && crashedTask.checkpoint.partial?.content[0]!.type === "text" ? crashedTask.checkpoint.partial.content[0].text : "", "Hello");
  assert.equal(harness.messages("c1").length, 1, "部分输出只在检查点里，不是 entry");
  const crashed = store.snapshot();

  const completed = assistantMessage([text("Hello there")]);
  const fresh = manualModel(["Hello there"], completed);
  const reopened = await DurableHarness.open({
    store: DurableStore.fromSnapshot(crashed),
    model: fresh.model,
    createId: ids("r"),
  });
  await reopened.run();
  const messages = reopened.messages("c1");
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "assistant"]);
  const aborted = messages[1]!;
  assert.equal(aborted.role === "assistant" && aborted.stopReason, "aborted");
  assert.equal(aborted.role === "assistant" && aborted.content[0]!.type === "text" ? aborted.content[0].text : "", "Hello");
  assert.deepEqual(messages[2], completed);
  assert.deepEqual(fresh.requests[0]!.messages, hanging.requests[0]!.messages, "重发用的是同样的消息");
  assert.equal(fresh.requests[0]!.messages.length, 1, "aborted entry 不在重发的请求里");
  const task = reopened.tasks()[0]!;
  assert.equal(task.status, "completed");
  assert.deepEqual(task.checkpoint, { phase: "request" });
});

test("Lab 19.4 · 模型以 error 结束时：错误回复落盘为 entry，不创建新的 generation；下一次 prompt 从新的用户消息继续", SLOW, async () => {
  const store = new DurableStore();
  const harness = await DurableHarness.open({
    store,
    model: new ScriptedModel([
      { stopReason: "error", errorMessage: "rate limited" },
      assistantMessage([text("recovered")]),
    ]),
    createId: ids(),
  });
  await harness.prompt("c1", "first");
  await harness.run();
  assert.deepEqual(harness.tasks().map((task) => `${task.kind}:${task.status}`), ["generation:completed"]);
  const failed = harness.messages("c1")[1]!;
  assert.equal(failed.role === "assistant" && failed.stopReason, "error");
  assert.equal(failed.role === "assistant" && failed.errorMessage, "rate limited");

  await harness.prompt("c1", "again");
  await harness.run();
  assert.deepEqual(
    harness.messages("c1").map((message) => message.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.deepEqual(harness.tasks().map((task) => task.status), ["completed", "completed"]);
});
