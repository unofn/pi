import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunResult } from "../src/agent-loop.js";
import type { Runtime } from "../src/composition.js";
import type {
  MessageSessionEntry,
  SessionEntry,
} from "../src/session.js";
import {
  assistantMessage,
  text,
  userMessage,
  type AgentMessage,
  type ToolCall,
  type ToolResultMessage,
} from "../src/types.js";
import {
  runEvalCase,
  runEvalSuite,
  type EvalCase,
  type PreparedEval,
  type TaskVerdict,
} from "../test-support/eval.js";

interface FakeRuntimeOptions {
  entries: readonly SessionEntry[];
  leafId: string | null;
  result?: AgentRunResult;
  promptError?: unknown;
  flushError?: unknown;
  entriesError?: unknown;
  disposeError?: unknown;
  events?: string[];
}

function messageEntry(
  id: string,
  parentId: string | null,
  message: AgentMessage,
): MessageSessionEntry {
  return {
    id,
    parentId,
    timestamp: 1,
    type: "message",
    message,
  };
}

function call(id: string, name = "write_file"): ToolCall {
  return {
    type: "toolCall",
    id,
    name,
    arguments: { path: "answer.txt" },
  };
}

function result(
  toolCall: ToolCall,
  value = "ok",
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [text(value)],
    details: { changed: true },
    isError: false,
    timestamp: 1,
  };
}

function pathWithTool(
  prefix: string,
  options: {
    callId?: string;
    callName?: string;
    resultName?: string;
    duplicateCall?: boolean;
    duplicateResult?: boolean;
    omitResult?: boolean;
    fileText?: string;
  } = {},
): {
  entries: MessageSessionEntry[];
  leafId: string;
  messages: AgentMessage[];
} {
  const toolCall = call(
    options.callId ?? `${prefix}-call`,
    options.callName,
  );
  const duplicate = options.duplicateCall
    ? { ...toolCall }
    : undefined;
  const toolResult = {
    ...result(toolCall, options.fileText),
    ...(options.resultName ? { toolName: options.resultName } : {}),
  };
  const messages: AgentMessage[] = [
    { ...userMessage(`build ${prefix}`), timestamp: 1 },
    assistantMessage(
      duplicate ? [toolCall, duplicate] : [toolCall],
      "toolUse",
      { timestamp: 2 },
    ),
    ...(
      options.omitResult
        ? []
        : options.duplicateResult
          ? [toolResult, structuredClone(toolResult)]
          : [toolResult]
    ),
    assistantMessage([text(`done ${prefix}`)], "stop", {
      timestamp: 4,
    }),
  ];
  let parentId: string | null = null;
  const entries = messages.map((message, index) => {
    const entry = messageEntry(
      `${prefix}-${index}`,
      parentId,
      message,
    );
    parentId = entry.id;
    return entry;
  });
  return {
    entries,
    leafId: entries.at(-1)!.id,
    messages,
  };
}

function fakeRuntime(options: FakeRuntimeOptions): Runtime {
  const transcript =
    options.result?.messages ??
    options.entries.flatMap((entry) =>
      entry.type === "message"
        ? [structuredClone(entry.message)]
        : []
    );
  const runResult: AgentRunResult =
    options.result ?? {
      reason: "stop",
      messages: transcript,
      steps: 2,
    };
  return {
    session: {
      async append() {
        throw new Error("eval fake does not append");
      },
      async entries() {
        options.events?.push("entries");
        if (options.entriesError !== undefined) {
          throw options.entriesError;
        }
        return structuredClone(options.entries);
      },
    },
    async prompt() {
      options.events?.push("prompt");
      if (options.promptError !== undefined) {
        throw options.promptError;
      }
      return structuredClone(runResult);
    },
    async flush() {
      options.events?.push("flush");
      if (options.flushError !== undefined) {
        throw options.flushError;
      }
    },
    getActiveLeafId() {
      return options.leafId;
    },
    async dispose() {
      options.events?.push("dispose");
      if (options.disposeError !== undefined) {
        throw options.disposeError;
      }
    },
  } as unknown as Runtime;
}

function passingCase(
  id: string,
  prepare: () => PreparedEval,
  overrides: Partial<EvalCase> = {},
): EvalCase {
  return {
    id,
    prompt: `prompt:${id}`,
    files: ["answer.txt"],
    prepare,
    judge(observation) {
      return {
        passed: true,
        checks: [observation.files["answer.txt"] === "ok"],
      };
    },
    ...overrides,
  };
}

test("Lab 14.1 · 同一个 case 每次都重新 prepare，且 runner 按执行、dispose、cleanup 收口", async () => {
  let preparedCount = 0;
  const runs: string[][] = [];
  const seenFiles: string[] = [];
  const evalCase = passingCase("fresh-each-run", () => {
    preparedCount += 1;
    const runEvents: string[] = [];
    runs.push(runEvents);
    const path = pathWithTool(`run-${preparedCount}`);
    return {
      runtime: fakeRuntime({
        entries: path.entries,
        leafId: path.leafId,
        events: runEvents,
      }),
      readFile(file) {
        runEvents.push(`read:${file}`);
        return "ok";
      },
      cleanup() {
        runEvents.push("cleanup");
      },
    };
  }, {
    judge(observation) {
      seenFiles.push(observation.files["answer.txt"]!);
      return { passed: true, checks: [true] };
    },
  });

  const first = await runEvalCase(evalCase);
  const second = await runEvalCase(evalCase);

  assert.equal(first.status, "passed");
  assert.equal(second.status, "passed");
  assert.equal(preparedCount, 2);
  assert.deepEqual(seenFiles, ["ok", "ok"]);
  assert.deepEqual(runs, [
    [
      "prompt",
      "flush",
      "entries",
      "read:answer.txt",
      "dispose",
      "cleanup",
    ],
    [
      "prompt",
      "flush",
      "entries",
      "read:answer.txt",
      "dispose",
      "cleanup",
    ],
  ]);
});

test("Lab 14.1 · judge 只看到 active path 与声明文件，而且观察值已深复制并冻结", async () => {
  const active = pathWithTool("active", {
    callId: "selected-call",
  });
  const sibling = messageEntry(
    "sibling-secret",
    active.entries[0]!.id,
    assistantMessage([text("RAW_SIBLING_SECRET")]),
  );
  const sourceEntries: SessionEntry[] = [
    ...active.entries,
    sibling,
  ];
  const reads: string[] = [];
  let mutationBlocked = false;
  const report = await runEvalCase(passingCase(
    "frozen-observation",
    () => ({
      runtime: fakeRuntime({
        entries: sourceEntries,
        leafId: active.leafId,
        result: {
          reason: "stop",
          messages: active.messages,
          steps: 2,
        },
      }),
      readFile(file) {
        reads.push(file);
        return file === "answer.txt" ? "ok" : "UNDECLARED";
      },
    }),
    {
      judge(observation) {
        assert.deepEqual(
          observation.entries.map((entry) => entry.id),
          active.entries.map((entry) => entry.id),
        );
        assert.deepEqual(Object.keys(observation.files), [
          "answer.txt",
        ]);
        assert.equal(Object.isFrozen(observation), true);
        assert.equal(Object.isFrozen(observation.entries), true);
        assert.equal(
          Object.isFrozen(observation.result.messages[0]),
          true,
        );
        assert.throws(() => {
          (
            observation.files as Record<string, string>
          )["answer.txt"] = "mutated";
        }, TypeError);
        try {
          (
            observation.entries as SessionEntry[]
          ).push(sibling);
        } catch (error) {
          mutationBlocked = error instanceof TypeError;
        }
        return { passed: true, checks: [mutationBlocked] };
      },
    },
  ));

  sourceEntries[0]!.id = "mutated-after-prepare";
  assert.equal(report.status, "passed");
  assert.deepEqual(reads, ["answer.txt"]);
  assert.equal(mutationBlocked, true);
});

test("Lab 14.1 · 执行故障与收集故障由 runner 分成不同 infra phase", async () => {
  const valid = pathWithTool("infra");
  const execute = await runEvalCase(passingCase(
    "execute-error",
    () => ({
      runtime: fakeRuntime({
        entries: valid.entries,
        leafId: valid.leafId,
        promptError: new Error("RAW_EXECUTE_SECRET"),
      }),
      readFile: () => "ok",
    }),
  ));
  const collect = await runEvalCase(passingCase(
    "collect-error",
    () => ({
      runtime: fakeRuntime({
        entries: valid.entries,
        leafId: valid.leafId,
      }),
      readFile() {
        throw new Error("RAW_FILE_SECRET");
      },
    }),
  ));
  const nonString = await runEvalCase(passingCase(
    "non-string-file",
    () => ({
      runtime: fakeRuntime({
        entries: valid.entries,
        leafId: valid.leafId,
      }),
      readFile() {
        return 41 as unknown as string;
      },
    }),
  ));

  assert.deepEqual(
    [execute.status, execute.primaryFailure],
    ["infra_failed", { phase: "execute", code: "execute_failed" }],
  );
  assert.deepEqual(
    [collect.status, collect.primaryFailure],
    ["infra_failed", { phase: "collect", code: "collect_failed" }],
  );
  assert.deepEqual(
    [nonString.status, nonString.primaryFailure],
    ["infra_failed", { phase: "collect", code: "collect_failed" }],
  );
});

test("Lab 14.2 · task verdict 只决定任务成败，自相矛盾的 verdict 属于 judge infra", async () => {
  const valid = pathWithTool("oracle");
  const prepared = () => ({
    runtime: fakeRuntime({
      entries: valid.entries,
      leafId: valid.leafId,
    }),
    readFile: () => "ok",
  });
  const rejected = await runEvalCase(passingCase(
    "task-rejected",
    prepared,
    {
      judge() {
        return {
          passed: false,
          checks: [true, false],
        };
      },
    },
  ));
  const contradictory = await runEvalCase(passingCase(
    "contradictory",
    prepared,
    {
      judge() {
        return {
          passed: true,
          checks: [true, false],
        } as TaskVerdict;
      },
    },
  ));

  assert.deepEqual(
    [rejected.status, rejected.primaryFailure],
    ["task_failed", { phase: "task", code: "task_rejected" }],
  );
  assert.deepEqual(rejected.evidence.checks, {
    passed: 1,
    failed: 1,
  });
  assert.deepEqual(
    [contradictory.status, contradictory.primaryFailure],
    ["infra_failed", { phase: "judge", code: "invalid_verdict" }],
  );
});

test("Lab 14.2 · active path 拒绝不一致 transcript、跨 assistant 补交、重复或悬空 call", async () => {
  const duplicate = pathWithTool("duplicate", {
    callId: "same-call",
    duplicateCall: true,
  });
  const unpaired = pathWithTool("unpaired", {
    callId: "never-finished",
    omitResult: true,
  });
  const lateCall = call("late-across-assistant");
  const lateMessages: AgentMessage[] = [
    { ...userMessage("late result"), timestamp: 1 },
    assistantMessage([lateCall], "toolUse", { timestamp: 2 }),
    assistantMessage([text("continued too early")], "stop", {
      timestamp: 3,
    }),
    result(lateCall),
  ];
  let lateParent: string | null = null;
  const lateEntries = lateMessages.map((message, index) => {
    const entry = messageEntry(
      `late-${index}`,
      lateParent,
      message,
    );
    lateParent = entry.id;
    return entry;
  });
  const consistent = pathWithTool("split-brain", {
    callId: "split-brain-call",
  });
  const inconsistentResult: AgentRunResult = {
    reason: "stop",
    steps: 2,
    messages: consistent.messages.map((message, index) =>
      index === consistent.messages.length - 1
        ? assistantMessage([text("forged success")], "stop", {
            timestamp: 4,
          })
        : structuredClone(message)
    ),
  };
  const duplicateReport = await runEvalCase(passingCase(
    "duplicate-protocol",
    () => ({
      runtime: fakeRuntime({
        entries: duplicate.entries,
        leafId: duplicate.leafId,
      }),
      readFile: () => "ok",
    }),
  ));
  const unpairedReport = await runEvalCase(passingCase(
    "unpaired-protocol",
    () => ({
      runtime: fakeRuntime({
        entries: unpaired.entries,
        leafId: unpaired.leafId,
      }),
      readFile: () => "ok",
    }),
  ));
  const lateReport = await runEvalCase(passingCase(
    "late-protocol",
    () => ({
      runtime: fakeRuntime({
        entries: lateEntries,
        leafId: lateEntries.at(-1)!.id,
      }),
      readFile: () => "ok",
    }),
  ));
  const mismatchReport = await runEvalCase(passingCase(
    "result-session-mismatch",
    () => ({
      runtime: fakeRuntime({
        entries: consistent.entries,
        leafId: consistent.leafId,
        result: inconsistentResult,
      }),
      readFile: () => "ok",
    }),
  ));

  assert.deepEqual(duplicateReport.primaryFailure, {
    phase: "protocol",
    code: "duplicate_tool_call",
  });
  assert.deepEqual(unpairedReport.primaryFailure, {
    phase: "protocol",
    code: "unpaired_tool_call",
  });
  assert.deepEqual(lateReport.primaryFailure, {
    phase: "protocol",
    code: "unpaired_tool_call",
  });
  assert.deepEqual(mismatchReport.primaryFailure, {
    phase: "protocol",
    code: "result_session_mismatch",
  });
  assert.equal(duplicateReport.status, "protocol_failed");
  assert.equal(unpairedReport.status, "protocol_failed");
  assert.equal(lateReport.status, "protocol_failed");
  assert.equal(mismatchReport.status, "protocol_failed");
});

test("Lab 14.2 · active path 接受 system message，且不参与 tool call / result 配对检查", async () => {
  const toolCall = call("system-path-call");
  const messages: AgentMessage[] = [
    {
      role: "system",
      content: "BASE",
      sections: { rules: "RULE v1" },
      timestamp: 0,
    },
    { ...userMessage("first"), timestamp: 1 },
    assistantMessage([toolCall], "toolUse", { timestamp: 2 }),
    result(toolCall),
    assistantMessage([text("done first")], "stop", { timestamp: 4 }),
    {
      role: "system",
      content: "",
      sections: { rules: "RULE v2" },
      timestamp: 5,
    },
    { ...userMessage("second"), timestamp: 6 },
    assistantMessage([text("done second")], "stop", { timestamp: 7 }),
  ];
  let parentId: string | null = null;
  const entries = messages.map((message, index) => {
    const entry = messageEntry(`system-${index}`, parentId, message);
    parentId = entry.id;
    return entry;
  });
  const report = await runEvalCase(passingCase(
    "system-path",
    () => ({
      runtime: fakeRuntime({
        entries,
        leafId: entries.at(-1)!.id,
      }),
      readFile: () => "ok",
    }),
  ));

  assert.equal(report.status, "passed");
  assert.equal(report.primaryFailure, undefined);
  assert.deepEqual(report.evidence.messages, {
    system: 2,
    user: 2,
    assistant: 3,
    toolResult: 1,
  });
  assert.deepEqual(report.evidence.tools, {
    calls: 1,
    results: 1,
    errors: 0,
  });
  assert.doesNotMatch(JSON.stringify(report), /BASE|RULE/);

  const danglingEntries = entries.filter(
    (entry) => entry.id !== "system-3",
  ).map((entry, index, kept) => ({
    ...entry,
    parentId: index === 0 ? null : kept[index - 1]!.id,
  }));
  const dangling = await runEvalCase(passingCase(
    "system-path-dangling",
    () => ({
      runtime: fakeRuntime({
        entries: danglingEntries,
        leafId: danglingEntries.at(-1)!.id,
      }),
      readFile: () => "ok",
    }),
  ));
  assert.deepEqual(
    dangling.primaryFailure,
    { phase: "protocol", code: "unpaired_tool_call" },
    "system message 不能替代缺失的 tool result",
  );
});

test("Lab 14.2 · prepare 与 judge 的异常只留下固定分层，不泄露异常正文", async () => {
  const valid = pathWithTool("layer");
  const prepareReport = await runEvalCase({
    id: "prepare-layer",
    prompt: "prepare",
    files: [],
    prepare() {
      throw new Error("RAW_PREPARE_TOKEN");
    },
    judge() {
      return { passed: true, checks: [] };
    },
  });
  const judgeReport = await runEvalCase(passingCase(
    "judge-layer",
    () => ({
      runtime: fakeRuntime({
        entries: valid.entries,
        leafId: valid.leafId,
      }),
      readFile: () => "ok",
    }),
    {
      judge() {
        throw new Error("RAW_JUDGE_TOKEN");
      },
    },
  ));

  assert.deepEqual(prepareReport.primaryFailure, {
    phase: "prepare",
    code: "prepare_failed",
  });
  assert.deepEqual(judgeReport.primaryFailure, {
    phase: "judge",
    code: "judge_failed",
  });
  assert.doesNotMatch(
    JSON.stringify([prepareReport, judgeReport]),
    /RAW_|TOKEN/,
  );
});

test("Lab 14.3 · SafeEvidence 只保留计数，不包含 transcript、文件、路径或 callId", async () => {
  const rawSecret = "sk-live-RAW-CAPSTONE-SECRET";
  const valid = pathWithTool("safe", {
    callId: "raw-sensitive-call-id",
    fileText: rawSecret,
  });
  const report = await runEvalCase(passingCase(
    "safe-report",
    () => ({
      runtime: fakeRuntime({
        entries: valid.entries,
        leafId: valid.leafId,
      }),
      readFile: () => `/private/work/${rawSecret}/answer`,
    }),
    {
      judge() {
        return { passed: false, checks: [true, false, true] };
      },
    },
  ));

  assert.deepEqual(report.evidence, {
    messages: { system: 0, user: 1, assistant: 2, toolResult: 1 },
    tools: { calls: 1, results: 1, errors: 0 },
    files: { requested: 1, read: 1 },
    checks: { passed: 2, failed: 1 },
  });
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(
    serialized,
    /RAW-CAPSTONE|raw-sensitive|private\/work|answer\.txt|sk-live/,
  );
  assert.deepEqual(Object.keys(report).sort(), [
    "evidence",
    "id",
    "primaryFailure",
    "secondaryFailures",
    "status",
  ]);
});

test("Lab 14.3 · dispose 与 cleanup 不覆盖已有 primary，只按发生顺序追加 secondary", async () => {
  const valid = pathWithTool("cleanup");
  const events: string[] = [];
  const prepared = () => ({
    runtime: fakeRuntime({
      entries: valid.entries,
      leafId: valid.leafId,
      disposeError: new Error("RAW_DISPOSE"),
      events,
    }),
    readFile: () => "ok",
    cleanup() {
      events.push("cleanup");
      throw new Error("RAW_CLEANUP");
    },
  });
  const taskFailed = await runEvalCase(passingCase(
    "task-before-cleanup",
    prepared,
    {
      judge() {
        return { passed: false, checks: [false] };
      },
    },
  ));
  const cleanupPrimary = await runEvalCase(passingCase(
    "cleanup-primary",
    prepared,
  ));

  assert.deepEqual(taskFailed.primaryFailure, {
    phase: "task",
    code: "task_rejected",
  });
  assert.deepEqual(taskFailed.secondaryFailures, [
    { phase: "dispose", code: "dispose_failed" },
    { phase: "cleanup", code: "cleanup_failed" },
  ]);
  assert.equal(taskFailed.status, "task_failed");
  assert.deepEqual(cleanupPrimary.primaryFailure, {
    phase: "dispose",
    code: "dispose_failed",
  });
  assert.deepEqual(cleanupPrimary.secondaryFailures, [
    { phase: "cleanup", code: "cleanup_failed" },
  ]);
  assert.equal(cleanupPrimary.status, "infra_failed");
  assert.equal(
    events.filter((event) => event === "dispose").length,
    2,
  );
  assert.equal(
    events.filter((event) => event === "cleanup").length,
    2,
  );
});

test("Lab 14.3 · suite 串行保持输入顺序，并对重复 case 重新 prepare", async () => {
  const sequence: string[] = [];
  let alphaRuns = 0;
  const makeCase = (id: string): EvalCase =>
    passingCase(id, () => {
      if (id === "alpha") alphaRuns += 1;
      sequence.push(`prepare:${id}`);
      const valid = pathWithTool(`${id}-${sequence.length}`);
      return {
        runtime: fakeRuntime({
          entries: valid.entries,
          leafId: valid.leafId,
          events: sequence,
        }),
        readFile() {
          sequence.push(`read:${id}`);
          return "ok";
        },
        cleanup() {
          sequence.push(`cleanup:${id}`);
        },
      };
    });
  const alpha = makeCase("alpha");
  const beta = makeCase("beta");

  const reports = await runEvalSuite([alpha, beta, alpha]);

  assert.deepEqual(
    reports.map((report) => report.id),
    ["alpha", "beta", "alpha"],
  );
  assert.deepEqual(
    reports.map((report) => report.status),
    ["passed", "passed", "passed"],
  );
  assert.equal(alphaRuns, 2);
  assert.deepEqual(
    sequence.filter((event) => event.startsWith("prepare:")),
    ["prepare:alpha", "prepare:beta", "prepare:alpha"],
  );
  assert.deepEqual(
    sequence.filter(
      (event) =>
        event.startsWith("prepare:") ||
        event.startsWith("cleanup:"),
    ),
    [
      "prepare:alpha",
      "cleanup:alpha",
      "prepare:beta",
      "cleanup:beta",
      "prepare:alpha",
      "cleanup:alpha",
    ],
  );
});
