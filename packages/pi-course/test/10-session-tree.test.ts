import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  InMemorySessionStore,
  JsonlSessionStore,
  messagesOnPath,
  parseSessionEntry,
  pathTo,
  recoverJsonl,
  type JsonValue,
  type MessageSessionEntry,
  type MetadataSessionEntry,
  type SessionEntry,
  type SessionFileIO,
} from "../src/session.js";
import {
  assistantMessage,
  text,
  textOf,
  userMessage,
  type AgentMessage,
  type ToolCall,
  type ToolResultMessage,
} from "../src/types.js";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function messageEntry<TMessage extends AgentMessage>(
  id: string,
  parentId: string | null,
  message: TMessage,
): MessageSessionEntry & { message: TMessage } {
  return {
    id,
    parentId,
    timestamp: 1,
    type: "message",
    message,
  };
}

function metadataEntry(
  id: string,
  parentId: string | null,
  key: string,
  value: JsonValue,
): MetadataSessionEntry {
  return {
    id,
    parentId,
    timestamp: 1,
    type: "metadata",
    key,
    value,
  };
}

function committed(...entries: SessionEntry[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("预期 Promise 被拒绝，但它成功了");
}

class MemorySessionFileIO implements SessionFileIO {
  ensureCalls = 0;
  readCalls = 0;
  readonly appendCalls: string[] = [];
  onAppend?: (value: string, callIndex: number) => Promise<void>;

  constructor(public value = "") {}

  async ensureFile(_file: string): Promise<void> {
    this.ensureCalls += 1;
  }

  async readFile(_file: string): Promise<string> {
    this.readCalls += 1;
    return this.value;
  }

  async appendFile(_file: string, value: string): Promise<void> {
    const callIndex = this.appendCalls.length;
    this.appendCalls.push(value);
    if (this.onAppend) {
      await this.onAppend(value, callIndex);
      return;
    }
    this.value += value;
  }
}

test("Lab 10.1 · pathTo 选择分支，只诊断所选祖先链", () => {
  const entries = [
    messageEntry("root", null, userMessage("root")),
    messageEntry(
      "left",
      "root",
      assistantMessage([text("left")]),
    ),
    messageEntry(
      "right",
      "root",
      assistantMessage([text("right")]),
    ),
    messageEntry("other-root", null, userMessage("other")),
    messageEntry("unselected-broken", "missing", userMessage("later")),
  ];

  assert.deepEqual(
    pathTo(entries, "left").map((entry) => entry.id),
    ["root", "left"],
  );
  assert.deepEqual(
    pathTo(entries, "right").map((entry) => entry.id),
    ["root", "right"],
  );
  assert.throws(
    () => pathTo(entries, "unknown-leaf"),
    /unknown-leaf/,
  );
  assert.throws(
    () =>
      pathTo(
        [messageEntry("child", "missing-parent", userMessage("x"))],
        "child",
      ),
    /child.*missing-parent/,
  );
  assert.throws(
    () =>
      pathTo(
        [
          messageEntry("cycle-a", "cycle-b", userMessage("a")),
          messageEntry("cycle-b", "cycle-a", userMessage("b")),
        ],
        "cycle-a",
      ),
    /cycle-a|cycle-b/,
  );
});

test("Lab 10.1 · pathTo 全局拒绝重复 id，并返回深副本", () => {
  const root = messageEntry("root", null, userMessage("before"));
  const leaf = metadataEntry("leaf", "root", "mode", {
    nested: ["safe"],
  });
  const selected = pathTo([root, leaf], "leaf");

  const rootBlock = root.message.content[0];
  if (rootBlock?.type !== "text") {
    throw new Error("fixture 应该包含 text block");
  }
  rootBlock.text = "source changed";
  assert.equal(selected[0]?.type, "message");
  if (
    selected[0]?.type === "message" &&
    selected[0].message.role === "user"
  ) {
    const selectedBlock = selected[0].message.content[0];
    assert.equal(selectedBlock?.type, "text");
    if (selectedBlock?.type === "text") {
      assert.equal(selectedBlock.text, "before");
    }
  }
  if (selected[1]?.type === "metadata") {
    const value = selected[1].value as { nested: string[] };
    value.nested[0] = "result changed";
  }
  assert.deepEqual(leaf.value, { nested: ["safe"] });

  assert.throws(
    () =>
      pathTo(
        [
          root,
          leaf,
          messageEntry("duplicate", null, userMessage("one")),
          metadataEntry("duplicate", null, "branch", true),
        ],
        "leaf",
      ),
    /duplicate/,
  );
});

test("Lab 10.2 · parseSessionEntry 收窄两种 entry，并复制嵌套 payload", () => {
  const argumentsValue = { path: "a.txt", flags: [true, null] };
  const call: ToolCall = {
    type: "toolCall",
    id: "call-1",
    name: "read",
    arguments: argumentsValue,
    rawArguments: '{"path":"a.txt"}',
  };
  const source = messageEntry(
    "assistant",
    null,
    assistantMessage([text("checking"), call], "toolUse", {
      timestamp: 2,
    }),
  );
  const parsed = parseSessionEntry(source);
  assert.deepEqual(parsed, source);
  assert.notEqual(parsed, source);
  if (
    parsed.type !== "message" ||
    parsed.message.role !== "assistant"
  ) {
    throw new Error("应该收窄成 assistant message entry");
  }
  const parsedCall = parsed.message.content[1];
  assert.equal(parsedCall?.type, "toolCall");
  if (parsedCall?.type === "toolCall") {
    assert.notEqual(parsedCall.arguments, argumentsValue);
  }

  const metadata = metadataEntry("meta", null, "settings", {
    nested: { count: 2 },
  });
  const parsedMetadata = parseSessionEntry(metadata);
  assert.deepEqual(parsedMetadata, metadata);
  assert.notEqual(parsedMetadata, metadata);
  if (parsedMetadata.type === "metadata") {
    assert.notEqual(parsedMetadata.value, metadata.value);
  }
});

test("Lab 10.2 · parseSessionEntry 接受 system message 并校验 sections", () => {
  const base = messageEntry("system", null, {
    role: "system",
    content: "You are Pi.",
    sections: { rules: "RULE v1", scratch: "SCRATCH" },
    timestamp: 0,
  });
  const parsed = parseSessionEntry(base);
  assert.deepEqual(parsed, base);
  assert.notEqual(parsed, base);
  if (parsed.type !== "message" || parsed.message.role !== "system") {
    throw new Error("应该收窄成 system message entry");
  }
  assert.notEqual(parsed.message.sections, base.message.sections);

  const patch = messageEntry("patch", "system", {
    role: "system",
    content: "",
    sections: { rules: "RULE v2", scratch: null },
    timestamp: 2,
  });
  assert.deepEqual(
    parseSessionEntry(patch),
    patch,
    "null 段落值是删除指令，必须原样保留",
  );

  const plain = messageEntry("plain", "patch", {
    role: "system",
    content: "no sections",
    timestamp: 3,
  });
  const parsedPlain = parseSessionEntry(plain);
  assert.deepEqual(parsedPlain, plain);
  assert.equal(
    parsedPlain.type === "message" && "sections" in parsedPlain.message,
    false,
    "没有 sections 时不补空对象",
  );
});

test("Lab 10.2 · parseSessionEntry 拒绝未知形状和非 JSON-safe 数据", () => {
  const invalidValues: Array<{ label: string; value: unknown }> = [
    { label: "array", value: [] },
    {
      label: "empty id",
      value: { ...messageEntry("x", null, userMessage("x")), id: "" },
    },
    {
      label: "NaN timestamp",
      value: {
        ...messageEntry("x", null, userMessage("x")),
        timestamp: Number.NaN,
      },
    },
    {
      label: "Infinity timestamp",
      value: {
        ...messageEntry("x", null, userMessage("x")),
        timestamp: Number.POSITIVE_INFINITY,
      },
    },
    {
      label: "unknown type",
      value: {
        id: "x",
        parentId: null,
        timestamp: 1,
        type: "compaction",
        summary: {},
      },
    },
    {
      label: "missing message payload",
      value: {
        id: "x",
        parentId: null,
        timestamp: 1,
        type: "message",
      },
    },
    {
      label: "unknown nested role",
      value: {
        id: "x",
        parentId: null,
        timestamp: 1,
        type: "message",
        message: { role: "tool", content: [], timestamp: 1 },
      },
    },
    {
      label: "system content not string",
      value: {
        id: "x",
        parentId: null,
        timestamp: 1,
        type: "message",
        message: { role: "system", content: [], timestamp: 1 },
      },
    },
    {
      label: "system sections not object",
      value: {
        id: "x",
        parentId: null,
        timestamp: 1,
        type: "message",
        message: {
          role: "system",
          content: "base",
          sections: ["rules"],
          timestamp: 1,
        },
      },
    },
    {
      label: "system section value not string or null",
      value: {
        id: "x",
        parentId: null,
        timestamp: 1,
        type: "message",
        message: {
          role: "system",
          content: "base",
          sections: { rules: 7 },
          timestamp: 1,
        },
      },
    },
    {
      label: "system unknown field",
      value: {
        id: "x",
        parentId: null,
        timestamp: 1,
        type: "message",
        message: {
          role: "system",
          content: "base",
          toolsAdded: [],
          timestamp: 1,
        },
      },
    },
    {
      label: "unknown nested field",
      value: {
        ...messageEntry("x", null, userMessage("x")),
        message: {
          ...userMessage("x"),
          silentlyDropped: true,
        },
      },
    },
    {
      label: "unknown content block",
      value: {
        ...messageEntry("x", null, userMessage("x")),
        message: {
          role: "user",
          content: [{ type: "image", url: "secret" }],
          timestamp: 1,
        },
      },
    },
    {
      label: "NaN usage",
      value: messageEntry(
        "x",
        null,
        assistantMessage([text("x")], "stop", {
          usage: {
            input: 1,
            output: 1,
            totalTokens: Number.NaN,
          },
        }),
      ),
    },
    {
      label: "function arguments",
      value: messageEntry(
        "x",
        null,
        assistantMessage([
          {
            type: "toolCall",
            id: "call",
            name: "run",
            arguments: { callback: () => "lost" },
          },
        ], "toolUse"),
      ),
    },
    {
      label: "Infinity details",
      value: messageEntry("x", null, {
        role: "toolResult",
        toolCallId: "call",
        toolName: "run",
        content: [text("done")],
        details: { duration: Number.POSITIVE_INFINITY },
        isError: false,
        timestamp: 1,
      }),
    },
    {
      label: "undefined metadata",
      value: {
        id: "x",
        parentId: null,
        timestamp: 1,
        type: "metadata",
        key: "bad",
        value: undefined,
      },
    },
    {
      label: "BigInt metadata",
      value: {
        ...metadataEntry("x", null, "bad", null),
        value: { count: 1n },
      },
    },
    {
      label: "unknown field",
      value: {
        ...metadataEntry("x", null, "ok", true),
        ignoredByJson: "must reject",
      },
    },
  ];

  for (const { label, value } of invalidValues) {
    assert.throws(
      () => parseSessionEntry(value),
      /.+/,
      `${label} 不应通过运行时边界`,
    );
  }
});

test("Lab 10.3 · InMemory append 在调用时取快照，并按 FIFO 提交", async () => {
  const store = new InMemorySessionStore();
  const root = messageEntry("root", null, userMessage("original"));
  const child = metadataEntry("child", "root", "mode", {
    value: "original",
  });
  const settled: string[] = [];

  const first = store.append(root).then(() => {
    settled.push("root");
  });
  const rootText = root.message.content[0];
  if (rootText?.type === "text") rootText.text = "mutated too late";
  const second = store.append(child).then(() => {
    settled.push("child");
  });
  child.id = "mutated-child";
  if (child.type === "metadata") {
    (child.value as { value: string }).value = "mutated too late";
  }

  await Promise.all([second, first]);
  assert.deepEqual(settled, ["root", "child"]);
  const firstRead = await store.entries();
  assert.deepEqual(firstRead.map((entry) => entry.id), ["root", "child"]);
  if (
    firstRead[0]?.type === "message" &&
    firstRead[0].message.role === "user"
  ) {
    const block = firstRead[0].message.content[0];
    assert.equal(block?.type, "text");
    if (block?.type === "text") {
      assert.equal(block.text, "original");
      block.text = "mutated read";
    }
  }
  if (firstRead[1]?.type === "metadata") {
    assert.deepEqual(firstRead[1].value, { value: "original" });
  }
  const secondRead = await store.entries();
  if (
    secondRead[0]?.type === "message" &&
    secondRead[0].message.role === "user"
  ) {
    const block = secondRead[0].message.content[0];
    assert.equal(block?.type, "text");
    if (block?.type === "text") {
      assert.equal(block.text, "original");
    }
  }
});

test("Lab 10.3 · InMemory 拒绝缺失 parent 和重复 id，失败不污染队列", async () => {
  const store = new InMemorySessionStore();
  await assert.rejects(
    store.append(messageEntry("child", "missing", userMessage("x"))),
    /child.*missing/,
  );
  await assert.rejects(
    store.append({
      ...metadataEntry("bad-json", null, "callback", null),
      value: { callback: () => "lost" },
    } as unknown as SessionEntry),
    /JSON|object|callback|必须/,
  );

  await store.append(messageEntry("root", null, userMessage("root")));
  await assert.rejects(
    store.append(metadataEntry("root", null, "duplicate", true)),
    /root/,
  );
  await store.append(metadataEntry("other-root", null, "ok", true));
  assert.deepEqual(
    (await store.entries()).map((entry) => entry.id),
    ["root", "other-root"],
  );
});

test("Lab 10.4 · recoverJsonl 读取已提交行，并明确忽略空行", () => {
  const root = messageEntry("root", null, userMessage("root"));
  const child = metadataEntry("child", "root", "mode", "test");
  const recovered = recoverJsonl(
    `\n${JSON.stringify(root)}\n   \n${JSON.stringify(child)}\n\n`,
  );

  assert.deepEqual(
    recovered.entries.map((entry) => entry.id),
    ["root", "child"],
  );
  assert.deepEqual(recovered.warnings, []);
});

test("Lab 10.4 · recoverJsonl 把任何无换行尾部视为未提交", () => {
  const root = messageEntry("root", null, userMessage("root"));
  const validTail = metadataEntry("tail", "root", "mode", "valid");
  const prefixes = [
    JSON.stringify(validTail),
    JSON.stringify({ id: "schema-invalid" }),
    '{"id":',
  ];

  for (const tail of prefixes) {
    const recovered = recoverJsonl(`${committed(root)}${tail}`);
    assert.deepEqual(
      recovered.entries.map((entry) => entry.id),
      ["root"],
    );
    assert.deepEqual(recovered.warnings, [
      { code: "unterminated_tail", line: 2 },
    ]);
  }
});

test("Lab 10.4 · recoverJsonl 对已换行的 JSON 或 schema 错误报告物理行号", () => {
  const root = messageEntry("root", null, userMessage("root"));
  assert.throws(
    () => recoverJsonl(`${committed(root)}BAD\n`),
    /第 2 行.*JSON/,
  );
  assert.throws(
    () =>
      recoverJsonl(
        `${committed(root)}${JSON.stringify({ id: "bad" })}\n`,
      ),
    /第 2 行.*session entry/,
  );
});

test("Lab 10.5 · Jsonl append 保留旧字节前缀，并可跨实例重开", async (t) => {
  const rootDirectory = await mkdtemp(
    path.join(os.tmpdir(), "pi-course-session-"),
  );
  const file = path.join(rootDirectory, "session", "run.jsonl");
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));

  const root = messageEntry("root", null, userMessage("root"));
  const store = await JsonlSessionStore.open(file);
  await store.append(root);
  const before = await readFile(file, "utf8");
  await assert.rejects(
    store.append(
      messageEntry("orphan", "missing", userMessage("orphan")),
    ),
    /orphan.*missing/,
  );
  await assert.rejects(
    store.append(metadataEntry("root", null, "duplicate", true)),
    /root/,
  );
  assert.equal(await readFile(file, "utf8"), before);
  await store.append(
    messageEntry(
      "answer",
      "root",
      assistantMessage([text("answer")]),
    ),
  );
  const after = await readFile(file, "utf8");
  assert.equal(after.slice(0, before.length), before);
  assert.ok(after.endsWith("\n"));

  const reopened = await JsonlSessionStore.open(file);
  assert.deepEqual(
    (await reopened.entries()).map((entry) => entry.id),
    ["root", "answer"],
  );
  assert.deepEqual((await reopened.read()).warnings, []);

  const invalidSchemaIO = new MemorySessionFileIO(
    `${JSON.stringify({ id: "bad" })}\n`,
  );
  await assert.rejects(
    JsonlSessionStore.open("invalid-schema.jsonl", invalidSchemaIO),
    /第 1 行.*session entry/,
  );
  const missingParentIO = new MemorySessionFileIO(
    committed(
      messageEntry("orphan-on-disk", "missing-on-disk", userMessage("x")),
    ),
  );
  await assert.rejects(
    JsonlSessionStore.open("missing-parent.jsonl", missingParentIO),
    /orphan-on-disk.*missing-on-disk/,
  );
});

test("Lab 10.5 · Jsonl 在调用时序列化，并用单实例 FIFO 写入", async () => {
  const io = new MemorySessionFileIO();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  io.onAppend = async (value, callIndex) => {
    if (callIndex === 0) {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    io.value += value;
  };
  const store = await JsonlSessionStore.open("memory.jsonl", io);
  const root = messageEntry("root", null, userMessage("before"));
  const child = metadataEntry("child", "root", "mode", {
    value: "before",
  });

  const first = store.append(root);
  const rootText = root.message.content[0];
  if (rootText?.type === "text") rootText.text = "after call";
  const second = store.append(child);
  child.id = "after-call-id";
  if (child.type === "metadata") {
    (child.value as { value: string }).value = "after call";
  }

  await firstStarted.promise;
  assert.equal(io.appendCalls.length, 1);
  releaseFirst.resolve();
  await Promise.all([second, first]);
  assert.equal(io.appendCalls.length, 2);
  const recovered = recoverJsonl(io.value);
  assert.deepEqual(
    recovered.entries.map((entry) => entry.id),
    ["root", "child"],
  );
  if (
    recovered.entries[0]?.type === "message" &&
    recovered.entries[0].message.role === "user"
  ) {
    const block = recovered.entries[0].message.content[0];
    assert.equal(block?.type, "text");
    if (block?.type === "text") assert.equal(block.text, "before");
  }
  if (recovered.entries[1]?.type === "metadata") {
    assert.deepEqual(recovered.entries[1].value, { value: "before" });
  }
});

test("Lab 10.5 · append I/O 失败后 writer fail-closed，重开只读等待修复", async () => {
  const healthyIO = new MemorySessionFileIO();
  const healthy = await JsonlSessionStore.open("healthy.jsonl", healthyIO);
  await assert.rejects(
    healthy.append({
      ...metadataEntry("bad", null, "callback", null),
      value: { callback: () => "lost" },
    } as unknown as SessionEntry),
  );
  assert.equal(healthyIO.appendCalls.length, 0);
  await healthy.append(
    messageEntry("healthy-root", null, userMessage("ok")),
  );
  assert.equal(healthyIO.appendCalls.length, 1);

  const root = messageEntry("root", null, userMessage("root"));
  const io = new MemorySessionFileIO(committed(root));
  const failureStarted = deferred();
  const releaseFailure = deferred();
  const originalCause = new Error("disk append failed");
  io.onAppend = async (value) => {
    io.value += value.slice(0, 12);
    failureStarted.resolve();
    await releaseFailure.promise;
    throw originalCause;
  };
  const store = await JsonlSessionStore.open("broken.jsonl", io);
  const failing = store.append(
    metadataEntry("child", "root", "mode", "first"),
  );
  const alreadyQueued = store.append(
    metadataEntry("other-root", null, "mode", "queued"),
  );
  await failureStarted.promise;
  releaseFailure.resolve();

  assert.equal(await rejectionOf(failing), originalCause);
  assert.equal(await rejectionOf(alreadyQueued), originalCause);
  const readsBeforeTerminalCalls = io.readCalls;
  assert.equal(
    await rejectionOf(
      store.append(metadataEntry("later", null, "mode", "later")),
    ),
    originalCause,
  );
  assert.equal(await rejectionOf(store.read()), originalCause);
  assert.equal(io.appendCalls.length, 1);
  assert.equal(io.readCalls, readsBeforeTerminalCalls);

  const reopened = await JsonlSessionStore.open("broken.jsonl", io);
  const recovered = await reopened.read();
  assert.deepEqual(
    recovered.entries.map((entry) => entry.id),
    ["root"],
  );
  assert.deepEqual(recovered.warnings, [
    { code: "unterminated_tail", line: 2 },
  ]);
  await assert.rejects(
    reopened.append(metadataEntry("repair", "root", "mode", "blocked")),
    /第 2 行.*修复/,
  );
  assert.equal(io.appendCalls.length, 1);
});

test("Lab 10.6 · messagesOnPath 只投影活动分支，完整保留工具事实", () => {
  const argumentsValue = {
    path: "src/index.ts",
    options: { encoding: "utf8" },
  };
  const call: ToolCall = {
    type: "toolCall",
    id: "call-read",
    name: "read",
    arguments: argumentsValue,
    rawArguments: '{"path":"src/index.ts"}',
  };
  const toolResult: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "call-read",
    toolName: "read",
    content: [text("permission denied")],
    details: { code: "EACCES", retryable: false },
    isError: true,
    timestamp: 3,
  };
  const entries = [
    messageEntry("root", null, userMessage("inspect")),
    messageEntry(
      "assistant",
      "root",
      assistantMessage([text("I will inspect"), call], "toolUse", {
        timestamp: 2,
      }),
    ),
    metadataEntry("meta", "assistant", "cwd", "/workspace"),
    messageEntry("result", "meta", toolResult),
    messageEntry(
      "sibling",
      "root",
      assistantMessage([text("wrong branch")]),
    ),
  ];

  const messages = messagesOnPath(entries, "result");
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "toolResult"],
  );
  assert.equal(
    messages.some((message) => textOf(message) === "wrong branch"),
    false,
  );
  const assistant = messages[1];
  assert.equal(assistant?.role, "assistant");
  if (assistant?.role === "assistant") {
    assert.deepEqual(assistant.content[1], call);
  }
  const result = messages[2];
  assert.equal(result?.role, "toolResult");
  if (result?.role === "toolResult") {
    assert.equal(result.toolCallId, "call-read");
    assert.equal(result.isError, true);
    assert.deepEqual(result.details, {
      code: "EACCES",
      retryable: false,
    });
  }
});

test("Lab 10.6 · messagesOnPath 的 arguments、details 与返回数组都不共享引用", () => {
  const argumentsValue = { nested: { path: "before.ts" } };
  const detailsValue = { nested: { bytes: 10 } };
  const call: ToolCall = {
    type: "toolCall",
    id: "call",
    name: "read",
    arguments: argumentsValue,
  };
  const result: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "call",
    toolName: "read",
    content: [text("done")],
    details: detailsValue,
    isError: false,
    timestamp: 3,
  };
  const entries = [
    messageEntry("root", null, userMessage("root")),
    messageEntry(
      "assistant",
      "root",
      assistantMessage([call], "toolUse", { timestamp: 2 }),
    ),
    messageEntry("result", "assistant", result),
  ];
  const messages = messagesOnPath(entries, "result");

  argumentsValue.nested.path = "source-mutated.ts";
  detailsValue.nested.bytes = 99;
  const projectedAssistant = messages[1];
  const projectedResult = messages[2];
  if (
    projectedAssistant?.role !== "assistant" ||
    projectedResult?.role !== "toolResult"
  ) {
    throw new Error("fixture 应该投影 assistant 和 toolResult");
  }
  const projectedCall = projectedAssistant.content[0];
  if (projectedCall?.type !== "toolCall") {
    throw new Error("fixture 应该保留 toolCall");
  }
  assert.deepEqual(projectedCall.arguments, {
    nested: { path: "before.ts" },
  });
  assert.deepEqual(projectedResult.details, {
    nested: { bytes: 10 },
  });

  (projectedCall.arguments as {
    nested: { path: string };
  }).nested.path = "output-mutated.ts";
  (projectedResult.details as {
    nested: { bytes: number };
  }).nested.bytes = -1;
  const projectedAgain = messagesOnPath(entries, "result");
  const assistantAgain = projectedAgain[1];
  const resultAgain = projectedAgain[2];
  if (
    assistantAgain?.role !== "assistant" ||
    resultAgain?.role !== "toolResult"
  ) {
    throw new Error("第二次投影应该保持消息角色");
  }
  const callAgain = assistantAgain.content[0];
  if (callAgain?.type !== "toolCall") {
    throw new Error("第二次投影应该保留 toolCall");
  }
  assert.deepEqual(callAgain.arguments, {
    nested: { path: "source-mutated.ts" },
  });
  assert.deepEqual(resultAgain.details, {
    nested: { bytes: 99 },
  });
});
