import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageEventStream } from "../src/event-stream.js";
import {
  assistantMessage,
  currentSystemMessage,
  currentSystemPrompt,
  systemMessageText,
  text,
  textOf,
  type AgentMessage,
  type SystemMessage,
} from "../src/types.js";

test("文本投影有损，但不修改 canonical content", () => {
  const message = assistantMessage([
    text("先读取"),
    {
      type: "toolCall",
      id: "c1",
      name: "read",
      arguments: { path: "README.md" },
    },
    text("再回答"),
  ]);
  const before = structuredClone(message.content);
  assert.equal(textOf(message), "先读取\n再回答");
  assert.deepEqual(message.content, before);
});

test(
  "error 也是协议终态，result resolve 最终消息",
  { timeout: 1_000 },
  async () => {
    const stream = new AssistantMessageEventStream();
    const error = assistantMessage([text("partial")], "error", {
      errorMessage: "socket reset",
    });
    stream.push({ type: "error", reason: "error", error });

    const observed = [];
    for await (const event of stream) observed.push(event.type);
    assert.deepEqual(observed, ["error"]);
    const result = await stream.result();
    assert.strictEqual(result, error);
    assert.equal(result.errorMessage, "socket reset");
  },
);

test("system message 按顺序重放：content 追加、sections 覆盖与 null 删除", () => {
  const base: SystemMessage = {
    role: "system",
    content: "You are Pi.",
    sections: { rules: "RULE v1", scratch: "SCRATCH" },
    timestamp: 10,
  };
  const patch: SystemMessage = {
    role: "system",
    content: "",
    sections: { rules: "RULE v2", scratch: null },
    timestamp: 20,
  };
  const note: SystemMessage = {
    role: "system",
    content: "Prefer small diffs.",
    timestamp: 30,
  };
  const messages: AgentMessage[] = [
    base,
    { role: "user", content: [text("go")], timestamp: 11 },
    patch,
    assistantMessage([text("ok")]),
    note,
  ];
  const before = structuredClone(messages);

  assert.deepEqual(currentSystemMessage(messages), {
    role: "system",
    content: "You are Pi.\n\nPrefer small diffs.",
    sections: { rules: "RULE v2" },
    timestamp: 10,
  });
  assert.equal(
    currentSystemPrompt(messages),
    "You are Pi.\n\nPrefer small diffs.\n\nRULE v2",
  );
  assert.deepEqual(messages, before, "重放不能改写任何 system message");

  assert.deepEqual(currentSystemMessage([base]), base);
  assert.equal(
    currentSystemMessage([
      { role: "user", content: [text("no system")], timestamp: 1 },
    ]),
    undefined,
  );
  assert.equal(currentSystemPrompt([]), undefined);
  const deleteOnly: SystemMessage = {
    role: "system",
    content: "",
    sections: { rules: null },
    timestamp: 40,
  };
  assert.deepEqual(
    currentSystemMessage([base, patch, deleteOnly]),
    { role: "system", content: "You are Pi.", timestamp: 10 },
    "段落全部删除后不保留空 sections",
  );
});

test("systemMessageText 按 content、sections 顺序拼接并跳过空串", () => {
  const message: SystemMessage = {
    role: "system",
    content: "",
    sections: { first: "A", empty: "", removed: null, last: "B" },
    timestamp: 1,
  };
  assert.equal(systemMessageText(message), "A\n\nB");
  assert.equal(
    systemMessageText({ role: "system", content: "only", timestamp: 1 }),
    "only",
  );
  assert.equal(textOf(message), "A\n\nB");
});
