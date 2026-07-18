import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunResult } from "../src/agent-loop.js";
import type { Runtime } from "../src/composition.js";
import type {
  MessageSessionEntry,
  MetadataSessionEntry,
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
} from "../test-support/eval.js";

function messageNode(
  id: string,
  parentId: string | null,
  message: AgentMessage,
): MessageSessionEntry {
  return {
    id,
    parentId,
    timestamp: 41,
    type: "message",
    message,
  };
}

function metadataNode(id: string): MetadataSessionEntry {
  return {
    id,
    parentId: null,
    timestamp: 40,
    type: "metadata",
    key: "fixture",
    value: "held-out",
  };
}

function invocation(id: string, name = "patch"): ToolCall {
  return {
    type: "toolCall",
    id,
    name,
    arguments: { line: 947, replacement: "bounded" },
  };
}

function outcome(
  toolCall: ToolCall,
  overrides: Partial<ToolResultMessage> = {},
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [text("applied")],
    details: { line: 947 },
    isError: false,
    timestamp: 44,
    ...overrides,
  };
}

function heldOutPath(
  seed: string,
  options: {
    resultName?: string;
    repeatResult?: boolean;
    siblingNoise?: boolean;
  } = {},
): {
  entries: SessionEntry[];
  leafId: string;
  messages: AgentMessage[];
} {
  const root = metadataNode(`${seed}-meta`);
  const toolCall = invocation(`${seed}-invoke-947`);
  const user = messageNode(
    `${seed}-request`,
    root.id,
    {
      ...userMessage(`repair held-out target ${seed}`),
      timestamp: 42,
    },
  );
  const assistant = messageNode(
    `${seed}-proposal`,
    user.id,
    assistantMessage([toolCall], "toolUse", {
      timestamp: 43,
    }),
  );
  const toolResult = outcome(toolCall, {
    ...(options.resultName
      ? { toolName: options.resultName }
      : {}),
  });
  const resultNode = messageNode(
    `${seed}-result`,
    assistant.id,
    toolResult,
  );
  const repeatedNode = options.repeatResult
    ? messageNode(
        `${seed}-result-again`,
        resultNode.id,
        structuredClone(toolResult),
      )
    : undefined;
  const parent = repeatedNode ?? resultNode;
  const final = messageNode(
    `${seed}-answer`,
    parent.id,
    assistantMessage([text(`verified ${seed}`)], "stop", {
      timestamp: 45,
    }),
  );
  const sibling = options.siblingNoise
    ? messageNode(
        `${seed}-unselected-noise`,
        user.id,
        {
          ...outcome(invocation(`${seed}-unknown-sibling`)),
          content: [text("RAW_UNSELECTED_BRANCH")],
        },
      )
    : undefined;
  const entries = [
    root,
    user,
    ...(sibling ? [sibling] : []),
    assistant,
    resultNode,
    ...(repeatedNode ? [repeatedNode] : []),
    final,
  ];
  return {
    entries,
    leafId: final.id,
    messages: entries.flatMap((entry) =>
      entry.type === "message" &&
      entry.id !== sibling?.id
        ? [entry.message]
        : []
    ),
  };
}

function heldOutRuntime(
  fixture: ReturnType<typeof heldOutPath>,
  options: {
    disposeError?: unknown;
    events?: string[];
  } = {},
): Runtime {
  const runResult: AgentRunResult = {
    reason: "stop",
    messages: structuredClone(fixture.messages),
    steps: 2,
  };
  return {
    session: {
      async append() {
        throw new Error("not used");
      },
      async entries() {
        options.events?.push("entries");
        return structuredClone(fixture.entries);
      },
    },
    async prompt() {
      options.events?.push("prompt");
      return structuredClone(runResult);
    },
    async flush() {
      options.events?.push("flush");
    },
    getActiveLeafId() {
      return fixture.leafId;
    },
    async dispose() {
      options.events?.push("dispose");
      if (options.disposeError !== undefined) {
        throw options.disposeError;
      }
    },
  } as unknown as Runtime;
}

test("Lab 14.4 · held-out case 改变路径与 callId，重复执行仍隔离且忽略未选分支", async () => {
  let generation = 0;
  const observedLeafs: string[] = [];
  const evalCase: EvalCase = {
    id: "hidden-branch-41",
    prompt: "repair artifact 41 without reading sibling branches",
    files: ["artifacts/result-41.json"],
    prepare() {
      generation += 1;
      const fixture = heldOutPath(`generation-${generation}`, {
        siblingNoise: true,
      });
      return {
        runtime: heldOutRuntime(fixture),
        readFile(file) {
          return JSON.stringify({
            file,
            generation,
            stable: true,
          });
        },
      };
    },
    judge(observation) {
      observedLeafs.push(observation.entries.at(-1)!.id);
      return {
        passed: true,
        checks: [
          !JSON.stringify(observation.entries).includes(
            "RAW_UNSELECTED_BRANCH",
          ),
          JSON.parse(
            observation.files["artifacts/result-41.json"]!,
          ).stable === true,
        ],
      };
    },
  };

  const reports = await runEvalSuite([evalCase, evalCase]);

  assert.deepEqual(
    reports.map((report) => report.status),
    ["passed", "passed"],
  );
  assert.equal(generation, 2);
  assert.deepEqual(observedLeafs, [
    "generation-1-answer",
    "generation-2-answer",
  ]);
});

test("Lab 14.4 · held-out 协议扰动分别识别 toolName 错配与重复 result", async () => {
  const makeCase = (
    id: string,
    fixture: ReturnType<typeof heldOutPath>,
  ): EvalCase => ({
    id,
    prompt: `probe ${id}`,
    files: [],
    prepare() {
      return {
        runtime: heldOutRuntime(fixture),
        readFile: () => "",
      };
    },
    judge() {
      return { passed: true, checks: [] };
    },
  });
  const wrongName = await runEvalCase(makeCase(
    "hidden-name-fault-73",
    heldOutPath("fault-name-73", {
      resultName: "replace",
    }),
  ));
  const repeated = await runEvalCase(makeCase(
    "hidden-repeat-fault-89",
    heldOutPath("fault-repeat-89", {
      repeatResult: true,
    }),
  ));

  assert.deepEqual(wrongName.primaryFailure, {
    phase: "protocol",
    code: "tool_name_mismatch",
  });
  assert.deepEqual(repeated.primaryFailure, {
    phase: "protocol",
    code: "duplicate_tool_result",
  });
  assert.equal(wrongName.status, "protocol_failed");
  assert.equal(repeated.status, "protocol_failed");
});

test("Lab 14.4 · held-out 文件故障保持 primary，生命周期故障只追加且报告脱敏", async () => {
  const fixture = heldOutPath("fault-stack-113");
  const events: string[] = [];
  const secret = "secret-held-out-113";
  const report = await runEvalCase({
    id: "hidden-cleanup-fault-113",
    prompt: "verify a path with injected read failure 113",
    files: ["private/variant-113.bin"],
    prepare() {
      return {
        runtime: heldOutRuntime(fixture, {
          events,
          disposeError: new Error(`dispose:${secret}`),
        }),
        readFile() {
          throw new Error(`read:${secret}`);
        },
        cleanup() {
          events.push("cleanup");
          throw new Error(`cleanup:${secret}`);
        },
      };
    },
    judge() {
      throw new Error("judge must not run");
    },
  });

  assert.equal(report.status, "infra_failed");
  assert.deepEqual(report.primaryFailure, {
    phase: "collect",
    code: "collect_failed",
  });
  assert.deepEqual(report.secondaryFailures, [
    { phase: "dispose", code: "dispose_failed" },
    { phase: "cleanup", code: "cleanup_failed" },
  ]);
  assert.deepEqual(events, [
    "prompt",
    "flush",
    "entries",
    "dispose",
    "cleanup",
  ]);
  assert.doesNotMatch(
    JSON.stringify(report),
    /secret-held-out|variant-113|private|stack/,
  );
});
