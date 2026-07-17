import assert from "node:assert/strict";
import test from "node:test";
import { ScriptedModel } from "../src/scripted-model.js";
import {
  assistantMessage,
  text,
  textOf,
  type ModelEvent,
  userMessage,
} from "../src/types.js";

test(
  "脚本消息被投影为真实事件协议，并保存请求快照",
  { timeout: 1_000 },
  async () => {
    const firstTurn = assistantMessage([
      text("先看"),
      {
        type: "toolCall",
        id: "c1",
        name: "read",
        arguments: { path: "README.md" },
      },
    ], "toolUse");
    const secondTurn = assistantMessage([text("第二轮")]);
    const model = new ScriptedModel([
      firstTurn,
      secondTurn,
    ]);
    const context = { messages: [userMessage("go")] };
    const stream = model.stream(context);
    context.messages.push(userMessage("事后追加"));
    const events: ModelEvent[] = [];
    for await (const event of stream) events.push(event);

    assert.deepEqual(events.map(({ type }) => type), [
      "start",
      "text_delta",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const start = events[0];
    assert.ok(start?.type === "start");
    assert.deepEqual(start.partial.content, []);

    const textDelta = events[1];
    assert.ok(textDelta?.type === "text_delta");
    assert.equal(textDelta.contentIndex, 0);
    assert.equal(textDelta.delta, "先看");
    assert.deepEqual(textDelta.partial.content, [text("先看")]);

    const toolDelta = events[2];
    assert.ok(toolDelta?.type === "toolcall_delta");
    assert.equal(toolDelta.contentIndex, 1);
    assert.equal(toolDelta.delta, '{"path":"README.md"}');
    assert.deepEqual(toolDelta.partial.content[0], text("先看"));
    assert.deepEqual(toolDelta.partial.content[1], {
      type: "toolCall",
      id: "c1",
      name: "read",
      arguments: {},
      rawArguments: '{"path":"README.md"}',
    });

    const toolEnd = events[3];
    assert.ok(toolEnd?.type === "toolcall_end");
    assert.equal(toolEnd.contentIndex, 1);
    assert.deepEqual(toolEnd.toolCall, firstTurn.content[1]);
    assert.deepEqual(toolEnd.partial.content, firstTurn.content);

    const done = events[4];
    assert.ok(done?.type === "done");
    assert.equal(done.reason, "toolUse");
    assert.deepEqual(done.message, firstTurn);
    assert.deepEqual(await stream.result(), firstTurn);
    assert.equal(model.requests.length, 1);
    assert.notStrictEqual(model.requests[0], context);
    assert.equal(model.requests[0]?.messages.length, 1);

    const secondStream = model.stream({ messages: [] });
    for await (const _event of secondStream) {
      // 消费第二轮。
    }
    assert.equal(textOf(await secondStream.result()), "第二轮");
    assert.equal(model.requests.length, 2);
  },
);

test(
  "显式错误回合保留 partial 与诊断",
  { timeout: 1_000 },
  async () => {
    const stream = new ScriptedModel([{
      stopReason: "error",
      partialText: "正在",
      errorMessage: "rate limited",
    }]).stream({ messages: [] });
    const events = [];
    for await (const event of stream) events.push(event.type);
    const result = await stream.result();

    assert.deepEqual(events, ["start", "text_delta", "error"]);
    assert.equal(result.stopReason, "error");
    assert.equal(textOf(result), "正在");
    assert.equal(result.errorMessage, "rate limited");
  },
);

test(
  "脚本耗尽与预取消都形成 error 终态",
  { timeout: 1_000 },
  async () => {
    const exhausted = new ScriptedModel([]);
    const empty = exhausted.stream({ messages: [] });
    const exhaustedEvents = [];
    for await (const event of empty) exhaustedEvents.push(event.type);
    const exhaustedResult = await empty.result();
    assert.deepEqual(exhaustedEvents, ["error"]);
    assert.equal(exhaustedResult.stopReason, "error");
    assert.equal(
      exhaustedResult.errorMessage,
      "ScriptedModel 没有更多响应",
    );

    const controller = new AbortController();
    controller.abort();
    const cancelled = new ScriptedModel([
      assistantMessage([text("不应出现")]),
    ]).stream({ messages: [] }, { signal: controller.signal });
    const cancelledEvents = [];
    for await (const event of cancelled) cancelledEvents.push(event.type);
    const cancelledResult = await cancelled.result();
    assert.deepEqual(cancelledEvents, ["error"]);
    assert.equal(cancelledResult.stopReason, "aborted");
    assert.equal(cancelledResult.errorMessage, "Request was aborted");
  },
);
