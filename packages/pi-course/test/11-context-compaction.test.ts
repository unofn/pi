import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildContext,
  createCompactionEntry,
  groupInteractions,
  type BuildContextOptions,
} from "../src/context.js";
import {
  InMemorySessionStore,
  JsonlSessionStore,
  parseSessionEntry,
  pathTo,
  type CompactionSessionEntry,
  type CompactionSummary,
  type MessageSessionEntry,
  type MetadataSessionEntry,
  type SessionEntry,
} from "../src/session.js";
import {
  assistantMessage,
  currentSystemPrompt,
  text,
  textOf,
  userMessage,
  type AgentMessage,
  type SystemMessage,
  type TextContent,
  type ToolCall,
  type ToolResultMessage,
} from "../src/types.js";

function summary(
  goal = "交付可恢复的会话",
): CompactionSummary {
  return {
    goal,
    constraints: ["保持工具事实完整"],
    completed: ["完成 session tree"],
    decisions: ["换行是 commit marker"],
    changedFiles: ["src/session.ts"],
    unresolved: ["跨进程锁"],
    next: ["接入 Agent"],
  };
}

function systemEntry(
  id: string,
  parentId: string | null,
  content: string,
  cost = 1,
  sections?: SystemMessage["sections"],
): MessageSessionEntry {
  return {
    id,
    parentId,
    timestamp: cost,
    type: "message",
    message: {
      role: "system",
      content,
      ...(sections ? { sections } : {}),
      timestamp: cost,
    },
  };
}

function userEntry(
  id: string,
  parentId: string | null,
  value: string,
  cost = 1,
): MessageSessionEntry {
  return {
    id,
    parentId,
    timestamp: cost,
    type: "message",
    message: {
      ...userMessage(value),
      timestamp: cost,
    },
  };
}

function assistantEntry(
  id: string,
  parentId: string | null,
  value: string,
  cost = 1,
): MessageSessionEntry {
  return {
    id,
    parentId,
    timestamp: cost,
    type: "message",
    message: assistantMessage([text(value)], "stop", {
      timestamp: cost,
    }),
  };
}

function assistantCallEntry(
  id: string,
  parentId: string | null,
  calls: ToolCall[],
  cost = 1,
): MessageSessionEntry {
  return {
    id,
    parentId,
    timestamp: cost,
    type: "message",
    message: assistantMessage(calls, "toolUse", {
      timestamp: cost,
    }),
  };
}

function resultEntry(
  id: string,
  parentId: string | null,
  call: ToolCall,
  value: string,
  cost = 1,
): MessageSessionEntry {
  const message: ToolResultMessage = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [text(value)],
    details: { order: value },
    isError: false,
    timestamp: cost,
  };
  return {
    id,
    parentId,
    timestamp: cost,
    type: "message",
    message,
  };
}

function metadataEntry(
  id: string,
  parentId: string | null,
): MetadataSessionEntry {
  return {
    id,
    parentId,
    timestamp: 1,
    type: "metadata",
    key: "cwd",
    value: "/workspace",
  };
}

function compactionEntry(
  id: string,
  parentId: string,
  value: CompactionSummary,
  firstKeptEntryId: string,
  tokensBefore = 80,
): CompactionSessionEntry {
  return {
    id,
    parentId,
    timestamp: 50,
    type: "compaction",
    summary: value,
    firstKeptEntryId,
    tokensBefore,
  };
}

function call(id: string, name = "probe"): ToolCall {
  return {
    type: "toolCall",
    id,
    name,
    arguments: { id },
  };
}

function textBlock(
  message: AgentMessage,
  index = 0,
): TextContent {
  const block =
    message.role === "system" ? undefined : message.content[index];
  if (block?.type !== "text") {
    throw new Error(`message content ${index} 应该是 text`);
  }
  return block;
}

function timestampOptions(
  overrides: Partial<BuildContextOptions> = {},
): BuildContextOptions {
  return {
    maxTokens: 100,
    reservedOutput: 0,
    safetyMargin: 0,
    estimateTokens(value: string | AgentMessage): number {
      return typeof value === "string" ? value.length : value.timestamp;
    },
    ...overrides,
  };
}

function unitOptions(
  overrides: Partial<BuildContextOptions> = {},
): BuildContextOptions {
  return {
    maxTokens: 100,
    reservedOutput: 0,
    safetyMargin: 0,
    estimateTokens(value: string | AgentMessage): number {
      if (typeof value === "string") return value.length;
      return textOf(value).startsWith("【会话压缩摘要】") ? 2 : 1;
    },
    ...overrides,
  };
}

test("Lab 11.1 · compaction schema 严格收窄并深复制七个摘要字段", () => {
  const source = compactionEntry(
    "compact-1",
    "answer-1",
    summary(),
    "user-2",
    144,
  );
  const parsed = parseSessionEntry(source);

  assert.equal(parsed.type, "compaction");
  assert.deepEqual(parsed, source);
  assert.notEqual(parsed, source);
  if (parsed.type !== "compaction") {
    throw new Error("应该收窄成 compaction entry");
  }
  assert.notEqual(parsed.summary, source.summary);
  assert.notEqual(
    parsed.summary.constraints,
    source.summary.constraints,
  );
  source.summary.constraints[0] = "mutated source";
  assert.deepEqual(parsed.summary.constraints, ["保持工具事实完整"]);
  parsed.summary.next[0] = "mutated result";
  assert.deepEqual(source.summary.next, ["接入 Agent"]);
});

test("Lab 11.1 · compaction schema 拒绝旧字段、缺字段与无效数字", () => {
  const valid = compactionEntry(
    "compact-valid",
    "parent",
    summary(),
    "keep",
  );
  assert.equal(parseSessionEntry(valid).type, "compaction");

  const invalid: Array<{ label: string; value: unknown }> = [
    {
      label: "null parent",
      value: { ...valid, parentId: null },
    },
    {
      label: "blank goal",
      value: {
        ...valid,
        summary: { ...summary(), goal: "   " },
      },
    },
    {
      label: "missing constraints",
      value: {
        ...valid,
        summary: {
          goal: "goal",
          completed: [],
          decisions: [],
          changedFiles: [],
          unresolved: [],
          next: [],
        },
      },
    },
    {
      label: "old summary aliases",
      value: {
        ...valid,
        summary: {
          ...summary(),
          files: [],
          nextSteps: [],
          invariants: [],
        },
      },
    },
    {
      label: "old compacted ids",
      value: { ...valid, compactedEntryIds: ["old"] },
    },
    {
      label: "missing first kept",
      value: {
        id: valid.id,
        parentId: valid.parentId,
        timestamp: valid.timestamp,
        type: valid.type,
        summary: valid.summary,
        tokensBefore: valid.tokensBefore,
      },
    },
    {
      label: "negative tokens",
      value: { ...valid, tokensBefore: -1 },
    },
    {
      label: "infinite tokens",
      value: {
        ...valid,
        tokensBefore: Number.POSITIVE_INFINITY,
      },
    },
    {
      label: "string timestamp",
      value: { ...valid, timestamp: "2026-07-19" },
    },
    {
      label: "non-string array member",
      value: {
        ...valid,
        summary: {
          ...summary(),
          decisions: ["valid", 7],
        },
      },
    },
  ];
  for (const { label, value } of invalid) {
    assert.throws(
      () => parseSessionEntry(value),
      /.+/,
      `${label} 不应通过 compaction 边界`,
    );
  }
});

test("Lab 11.1 · Memory 与 JSONL 都能写入并重开 compaction", async (t) => {
  const root = userEntry("user-1", null, "start");
  const compact = compactionEntry(
    "compact-1",
    "user-1",
    summary(),
    "user-1",
  );

  const memory = new InMemorySessionStore();
  await memory.append(root);
  await memory.append(compact);
  const memoryEntries = await memory.entries();
  assert.deepEqual(
    memoryEntries.map((entry) => entry.type),
    ["message", "compaction"],
  );
  assert.notEqual(memoryEntries[1], compact);

  const directory = await mkdtemp(
    path.join(os.tmpdir(), "pi-course-context-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "session.jsonl");
  const store = await JsonlSessionStore.open(file);
  await store.append(root);
  await store.append(compact);
  const reopened = await JsonlSessionStore.open(file);
  const reopenedEntries = await reopened.entries();
  assert.deepEqual(reopenedEntries, [root, compact]);
  assert.equal(reopenedEntries[1]?.type, "compaction");
});

test("Lab 11.2 · groupInteractions 以 user 为边界并返回独立副本", () => {
  const entries = [
    userEntry("u1", null, "one"),
    assistantEntry("a1", "u1", "answer one"),
    userEntry("u2", "a1", "two"),
    assistantEntry("a2", "u2", "answer two"),
  ];
  const snapshot = structuredClone(entries);
  const groups = groupInteractions(entries);

  assert.deepEqual(
    groups.map((group) =>
      group.entries.map((entry) => entry.id)
    ),
    [["u1", "a1"], ["u2", "a2"]],
  );
  textBlock(groups[0]!.entries[0]!.message).text = "changed output";
  assert.deepEqual(entries, snapshot);
  textBlock(entries[1]!.message).text = "changed source";
  assert.equal(
    textBlock(groups[0]!.entries[1]!.message).text,
    "answer one",
  );
});

test("Lab 11.2 · tool results 可反序出现，仍按 callId 完整配对", () => {
  const first = call("call-1", "first");
  const second = call("call-2", "second");
  const entries = [
    userEntry("u1", null, "run both"),
    assistantCallEntry("calls", "u1", [first, second]),
    resultEntry("result-2", "calls", second, "second done"),
    assistantEntry("progress", "result-2", "still working"),
    resultEntry("result-1", "progress", first, "first done"),
    assistantEntry("done", "result-1", "all done"),
  ];

  const groups = groupInteractions(entries);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0]?.entries.map((entry) => entry.id),
    [
      "u1",
      "calls",
      "result-2",
      "progress",
      "result-1",
      "done",
    ],
  );
});

test("Lab 11.2 · interaction 拒绝 orphan、duplicate 与 missing tool fact", () => {
  assert.equal(
    groupInteractions([
      userEntry("valid-u", null, "valid"),
      assistantEntry("valid-a", "valid-u", "done"),
    ]).length,
    1,
  );
  assert.throws(
    () =>
      groupInteractions([
        assistantEntry("orphan-assistant", null, "orphan"),
      ]),
    /orphan-assistant/,
  );

  const known = call("known");
  const unknown = call("unknown");
  assert.throws(
    () =>
      groupInteractions([
        userEntry("u", null, "run"),
        assistantCallEntry("calls", "u", [known]),
        resultEntry("orphan-result", "calls", unknown, "bad"),
      ]),
    /orphan-result.*unknown/,
  );
  assert.throws(
    () =>
      groupInteractions([
        userEntry("u", null, "run"),
        assistantCallEntry("duplicate-calls", "u", [known, known]),
        resultEntry("result", "duplicate-calls", known, "done"),
      ]),
    /known.*重复/,
  );
  assert.throws(
    () =>
      groupInteractions([
        userEntry("u", null, "run"),
        assistantCallEntry("calls", "u", [known]),
        resultEntry("result-1", "calls", known, "done"),
        resultEntry("result-2", "result-1", known, "again"),
      ]),
    /known.*重复/,
  );
  assert.throws(
    () =>
      groupInteractions([
        userEntry("u", null, "run"),
        assistantCallEntry("missing-result", "u", [known]),
      ]),
    /known.*缺少 result/,
  );
});

test("Lab 11.3 · buildContext 先扣 system、输出预留与安全余量", () => {
  const conversation = [
    userEntry("u1", "sys", "one", 3),
    assistantEntry("a1", "u1", "one answer", 4),
    userEntry("u2", "a1", "two", 3),
    assistantEntry("a2", "u2", "two answer", 4),
    userEntry("u3", "a2", "three", 3),
    assistantEntry("a3", "u3", "three answer", 4),
  ];
  const system = systemEntry("sys", null, "sys", 3);
  const entries = [system, ...conversation];
  const projected = buildContext(
    entries,
    timestampOptions({
      maxTokens: 29,
      reservedOutput: 4,
      safetyMargin: 2,
    }),
  );

  assert.deepEqual(projected.keptEntryIds, ["u2", "a2", "u3", "a3"]);
  assert.deepEqual(
    projected.messages[0],
    system.message,
    "重放出的 system message 固定在最前面，不计入 keptEntryIds",
  );
  assert.equal(currentSystemPrompt(projected.messages), "sys");
  assert.equal(projected.reason, "trimmed");
  assert.deepEqual(projected.tokens, {
    maxTokens: 29,
    system: 3,
    messages: 14,
    reservedOutput: 4,
    safetyMargin: 2,
    availableForMessages: 20,
    total: 23,
  });

  const withoutFixedCosts = buildContext(
    conversation,
    timestampOptions({ maxTokens: 29 }),
  );
  assert.deepEqual(
    withoutFixedCosts.keptEntryIds,
    ["u1", "a1", "u2", "a2", "u3", "a3"],
  );
  assert.equal(withoutFixedCosts.tokens.system, 0);
  assert.equal(withoutFixedCosts.messages[0]?.role, "user");
  assert.equal(currentSystemPrompt(withoutFixedCosts.messages), undefined);
});

test("Lab 11.3 · 最新单组超限时仍完整保留 user、call、results 与终态", () => {
  const old = [
    userEntry("old-u", null, "old", 1),
    assistantEntry("old-a", "old-u", "old answer", 1),
  ];
  const first = call("call-1");
  const second = call("call-2");
  const latest = [
    userEntry("u", "old-a", "latest", 3),
    assistantCallEntry("calls", "u", [first, second], 3),
    resultEntry("result-2", "calls", second, "second", 3),
    resultEntry("result-1", "result-2", first, "first", 3),
    assistantEntry("final", "result-1", "done", 3),
  ];

  const projected = buildContext(
    [...old, ...latest],
    timestampOptions({
      maxTokens: 10,
      reservedOutput: 1,
      safetyMargin: 1,
    }),
  );
  assert.equal(projected.reason, "single_group_overflow");
  assert.deepEqual(
    projected.keptEntryIds,
    latest.map((entry) => entry.id),
  );
  assert.deepEqual(
    projected.messages.map((message) => message.role),
    ["user", "assistant", "toolResult", "toolResult", "assistant"],
  );
  assert.equal(projected.tokens.messages, 15);
  assert.equal(projected.tokens.total, 17);
});

test("Lab 11.3 · 预算只在完整 group 边界截断，结果与输入不共享引用", () => {
  const argumentsValue = { nested: { path: "before.ts" } };
  const probe: ToolCall = {
    type: "toolCall",
    id: "probe",
    name: "read",
    arguments: argumentsValue,
  };
  const entries = [
    userEntry("old-u", null, "old", 2),
    assistantEntry("old-a", "old-u", "old answer", 2),
    userEntry("new-u", "old-a", "new", 2),
    assistantCallEntry("new-call", "new-u", [probe], 2),
    resultEntry("new-result", "new-call", probe, "done", 2),
    assistantEntry("new-final", "new-result", "final", 2),
  ];
  const snapshot = structuredClone(entries);
  const projected = buildContext(
    entries,
    timestampOptions({ maxTokens: 8 }),
  );

  assert.deepEqual(
    projected.keptEntryIds,
    ["new-u", "new-call", "new-result", "new-final"],
  );
  assert.equal(projected.reason, "trimmed");
  const callMessage = projected.messages[1];
  if (callMessage?.role !== "assistant") {
    throw new Error("第二条消息应该是 assistant tool call");
  }
  const projectedCall = callMessage.content[0];
  if (projectedCall?.type !== "toolCall") {
    throw new Error("assistant 应该保留 tool call");
  }
  (projectedCall.arguments as {
    nested: { path: string };
  }).nested.path = "changed output";
  assert.deepEqual(entries, snapshot);
  argumentsValue.nested.path = "changed source";
  assert.deepEqual(projectedCall.arguments, {
    nested: { path: "changed output" },
  });
});

test("Lab 11.4 · createCompactionEntry 推导 parent 并保持历史与输入独立", () => {
  const activePath: SessionEntry[] = [
    userEntry("u1", null, "one"),
    assistantEntry("a1", "u1", "answer one"),
    userEntry("u2", "a1", "two"),
    assistantEntry("a2", "u2", "answer two"),
  ];
  const activeSnapshot = structuredClone(activePath);
  const inputSummary = summary("继续完成上下文压缩");
  const created = createCompactionEntry(activePath, {
    id: "compact-1",
    timestamp: 100,
    summary: inputSummary,
    firstKeptEntryId: "u2",
    tokensBefore: 256,
  });

  assert.deepEqual(created, {
    id: "compact-1",
    parentId: "a2",
    timestamp: 100,
    type: "compaction",
    summary: inputSummary,
    firstKeptEntryId: "u2",
    tokensBefore: 256,
  });
  assert.deepEqual(activePath, activeSnapshot);
  assert.notEqual(created.summary, inputSummary);
  inputSummary.next[0] = "mutated source";
  assert.deepEqual(created.summary.next, ["接入 Agent"]);
  created.summary.constraints[0] = "mutated result";
  assert.deepEqual(
    activePath,
    activeSnapshot,
    "修改新 entry 不能反向修改历史",
  );
});

test("Lab 11.4 · createCompactionEntry 只接受完整 interaction 的首条 message", () => {
  const validPath: SessionEntry[] = [
    userEntry("u1", null, "one"),
    assistantEntry("a1", "u1", "answer"),
  ];
  assert.equal(
    createCompactionEntry(validPath, {
      id: "valid-compaction",
      timestamp: 10,
      summary: summary(),
      firstKeptEntryId: "u1",
      tokensBefore: 20,
    }).parentId,
    "a1",
  );

  const baseInput = {
    id: "compact",
    timestamp: 10,
    summary: summary(),
    tokensBefore: 20,
  };
  assert.throws(
    () =>
      createCompactionEntry([], {
        ...baseInput,
        firstKeptEntryId: "u1",
      }),
    /空 active path/,
  );
  assert.throws(
    () =>
      createCompactionEntry(validPath, {
        ...baseInput,
        firstKeptEntryId: "a1",
      }),
    /a1.*首条 message/,
  );
  assert.throws(
    () =>
      createCompactionEntry(validPath, {
        ...baseInput,
        firstKeptEntryId: "missing",
      }),
    /missing.*首条 message/,
  );
  assert.throws(
    () =>
      createCompactionEntry(validPath, {
        ...baseInput,
        id: "u1",
        firstKeptEntryId: "u1",
      }),
    /重复.*u1|u1.*重复/,
  );
});

test("Lab 11.5 · 恢复只用最新 compaction 摘要，并从 firstKept 保留后缀", () => {
  const firstSummary = summary("完成第一轮压缩");
  const fullLog: SessionEntry[] = [
    userEntry("u1", null, "old question"),
    assistantEntry("a1", "u1", "old answer"),
    userEntry("u2", "a1", "kept question"),
    assistantEntry("a2", "u2", "kept answer"),
    compactionEntry("compact-1", "a2", firstSummary, "u2"),
    metadataEntry("meta", "compact-1"),
    userEntry("u3", "meta", "new question"),
    assistantEntry("a3", "u3", "new answer"),
    assistantEntry("sibling", "a1", "wrong branch"),
  ];
  const activePath = pathTo(fullLog, "a3");
  const projected = buildContext(activePath, unitOptions());

  assert.deepEqual(
    projected.keptEntryIds,
    ["u2", "a2", "u3", "a3"],
  );
  assert.equal(projected.messages.length, 5);
  assert.equal(
    textOf(projected.messages[0]!),
    [
      "【会话压缩摘要】",
      "目标：完成第一轮压缩",
      "约束：",
      "- 保持工具事实完整",
      "已完成：",
      "- 完成 session tree",
      "决策：",
      "- 换行是 commit marker",
      "变更文件：",
      "- src/session.ts",
      "未解决：",
      "- 跨进程锁",
      "下一步：",
      "- 接入 Agent",
    ].join("\n"),
  );
  assert.equal(
    projected.messages.some((message) =>
      textOf(message).includes("wrong branch")
    ),
    false,
  );
  assert.equal(
    projected.messages.some((message) =>
      textOf(message).includes("old question")
    ),
    false,
  );
});

test("Lab 11.5 · 多次 compaction 只读取最新一条，重复构建结果确定且隔离", () => {
  const firstSummary = summary("first summary");
  const secondSummary = summary("second summary");
  secondSummary.constraints = [];
  secondSummary.unresolved = [];
  const activePath: SessionEntry[] = [
    userEntry("u1", null, "old"),
    assistantEntry("a1", "u1", "old answer"),
    userEntry("u2", "a1", "middle"),
    assistantEntry("a2", "u2", "middle answer"),
    compactionEntry("compact-1", "a2", firstSummary, "u2"),
    userEntry("u3", "compact-1", "recent"),
    assistantEntry("a3", "u3", "recent answer"),
    compactionEntry("compact-2", "a3", secondSummary, "u3"),
    userEntry("u4", "compact-2", "latest"),
    assistantEntry("a4", "u4", "latest answer"),
  ];
  const before = structuredClone(activePath);
  const first = buildContext(activePath, unitOptions());
  const second = buildContext(activePath, unitOptions());

  assert.deepEqual(first, second);
  assert.notEqual(first.messages, second.messages);
  assert.deepEqual(
    first.keptEntryIds,
    ["u3", "a3", "u4", "a4"],
  );
  assert.match(textOf(first.messages[0]!), /second summary/);
  assert.doesNotMatch(textOf(first.messages[0]!), /first summary/);
  assert.match(textOf(first.messages[0]!), /约束：\n- （无）/);
  assert.match(textOf(first.messages[0]!), /未解决：\n- （无）/);

  textBlock(first.messages[0]!).text = "mutated projection";
  assert.match(textOf(second.messages[0]!), /second summary/);
  assert.deepEqual(activePath, before);
});

test("Lab 11.5 · 恢复后的路径可以再次压缩，预算仍只截完整 group", () => {
  const activePath: SessionEntry[] = [
    userEntry("u1", null, "old"),
    assistantEntry("a1", "u1", "old answer"),
    userEntry("u2", "a1", "middle"),
    assistantEntry("a2", "u2", "middle answer"),
    compactionEntry(
      "compact-1",
      "a2",
      summary("first"),
      "u2",
    ),
    userEntry("u3", "compact-1", "recent"),
    assistantEntry("a3", "u3", "recent answer"),
  ];
  const second = createCompactionEntry(activePath, {
    id: "compact-2",
    timestamp: 200,
    summary: summary("second"),
    firstKeptEntryId: "u3",
    tokensBefore: 44,
  });
  assert.equal(second.parentId, "a3");
  const resumedPath: SessionEntry[] = [
    ...activePath,
    second,
    userEntry("u4", "compact-2", "latest"),
    assistantEntry("a4", "u4", "latest answer"),
  ];
  const projected = buildContext(
    resumedPath,
    unitOptions({ maxTokens: 4 }),
  );

  assert.equal(projected.reason, "trimmed");
  assert.deepEqual(projected.keptEntryIds, ["u4", "a4"]);
  assert.deepEqual(
    projected.messages.map((message) => textOf(message)),
    [
      textOf(projected.messages[0]!),
      "latest",
      "latest answer",
    ],
  );
  assert.match(textOf(projected.messages[0]!), /目标：second/);
  assert.equal(projected.tokens.messages, 4);
});

test("Lab 11.5 · system message 从整条 active path 重放，不进入 interaction 与摘要", () => {
  const activePath: SessionEntry[] = [
    systemEntry("sys", null, "BASE", 1, { rules: "RULE v1" }),
    userEntry("u1", "sys", "old question"),
    assistantEntry("a1", "u1", "old answer"),
    systemEntry("patch-1", "a1", "", 1, { rules: "RULE v2" }),
    userEntry("u2", "patch-1", "kept question"),
    assistantEntry("a2", "u2", "kept answer"),
    compactionEntry("compact-1", "a2", summary("压缩"), "u2"),
    systemEntry("patch-2", "compact-1", "Prefer small diffs."),
    userEntry("u3", "patch-2", "new question"),
    assistantEntry("a3", "u3", "new answer"),
  ];
  const before = structuredClone(activePath);

  assert.deepEqual(
    groupInteractions(
      activePath.filter(
        (entry): entry is MessageSessionEntry => entry.type === "message",
      ),
    ).map((group) => group.entries.map((entry) => entry.id)),
    [["u1", "a1"], ["u2", "a2"], ["u3", "a3"]],
    "system message 不属于任何 interaction",
  );

  const projected = buildContext(activePath, unitOptions());
  assert.deepEqual(projected.messages[0], {
    role: "system",
    content: "BASE\n\nPrefer small diffs.",
    sections: { rules: "RULE v2" },
    timestamp: 1,
  });
  assert.equal(
    currentSystemPrompt(projected.messages),
    "BASE\n\nPrefer small diffs.\n\nRULE v2",
    "compaction 之前的 system message 也参与重放",
  );
  assert.match(textOf(projected.messages[1]!), /【会话压缩摘要】/);
  assert.doesNotMatch(textOf(projected.messages[1]!), /BASE|RULE/);
  assert.deepEqual(
    projected.messages.slice(2).map((message) => message.role),
    ["user", "assistant", "user", "assistant"],
    "后缀里的 system message 已经折进开头，不再原位出现",
  );
  assert.deepEqual(projected.keptEntryIds, ["u2", "a2", "u3", "a3"]);
  assert.equal(projected.tokens.system, 1);
  assert.equal(projected.tokens.messages, 6);
  assert.deepEqual(activePath, before);

  assert.equal(
    createCompactionEntry(activePath, {
      id: "compact-2",
      timestamp: 300,
      summary: summary("再压缩"),
      firstKeptEntryId: "u3",
      tokensBefore: 10,
    }).parentId,
    "a3",
  );
  assert.throws(
    () =>
      createCompactionEntry(activePath, {
        id: "compact-3",
        timestamp: 300,
        summary: summary("错误起点"),
        firstKeptEntryId: "patch-2",
        tokensBefore: 10,
      }),
    /patch-2.*首条 message/,
    "system message 不能作为 interaction 起点",
  );
});
