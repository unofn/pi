import { isDeepStrictEqual } from "node:util";
import type { AgentRunResult } from "../src/agent-loop.js";
import type { Runtime } from "../src/composition.js";
import {
  pathTo,
  type SessionEntry,
} from "../src/session.js";
import type {
  AssistantMessage,
} from "../src/types.js";

export type Awaitable<T> = T | Promise<T>;

export interface PreparedEval {
  runtime: Runtime;
  readFile(file: string): Awaitable<string>;
  cleanup?(): Awaitable<void>;
}

export interface PassingTaskVerdict {
  passed: true;
  checks: readonly boolean[];
}

export interface FailingTaskVerdict {
  passed: false;
  checks: readonly boolean[];
}

export type TaskVerdict =
  | PassingTaskVerdict
  | FailingTaskVerdict;

export interface EvalObservation {
  readonly result: AgentRunResult;
  /**
   * 这里只包含 active leaf 的祖先链。未选中的 sibling branch 不属于本次事实。
   */
  readonly entries: readonly SessionEntry[];
  /**
   * 只读取 EvalCase.files 明确列出的文件。原始内容只交给 judge，不进入报告。
   */
  readonly files: Readonly<Record<string, string>>;
}

export interface EvalCase {
  id: string;
  prompt: string;
  files: readonly string[];
  prepare(): Awaitable<PreparedEval>;
  judge(observation: EvalObservation): Awaitable<TaskVerdict>;
}

export type EvalStatus =
  | "passed"
  | "task_failed"
  | "protocol_failed"
  | "infra_failed";

export type EvalFailurePhase =
  | "prepare"
  | "execute"
  | "collect"
  | "protocol"
  | "judge"
  | "task"
  | "dispose"
  | "cleanup";

export type EvalFailureCode =
  | "invalid_case"
  | "prepare_failed"
  | "execute_failed"
  | "collect_failed"
  | "missing_active_leaf"
  | "invalid_active_path"
  | "missing_user_interaction"
  | "incomplete_user_interaction"
  | "result_session_mismatch"
  | "assistant_without_user"
  | "tool_call_without_user"
  | "duplicate_tool_call"
  | "orphan_tool_result"
  | "duplicate_tool_result"
  | "tool_name_mismatch"
  | "unpaired_tool_call"
  | "judge_failed"
  | "invalid_verdict"
  | "task_rejected"
  | "dispose_failed"
  | "cleanup_failed";

/**
 * 故障只保留 runner 自己定义的固定枚举。外部 Error 的 message、cause 和
 * stack 都不能越过评测边界。
 */
export interface EvalFailure {
  phase: EvalFailurePhase;
  code: EvalFailureCode;
}

export interface SafeEvidence {
  messages: {
    system: number;
    user: number;
    assistant: number;
    toolResult: number;
  };
  tools: {
    calls: number;
    results: number;
    errors: number;
  };
  files: {
    requested: number;
    read: number;
  };
  checks: {
    passed: number;
    failed: number;
  };
}

export interface EvalReport {
  id: string;
  status: EvalStatus;
  evidence: SafeEvidence;
  primaryFailure?: EvalFailure;
  secondaryFailures: EvalFailure[];
}

class ProtocolViolation extends Error {
  constructor(readonly code: EvalFailureCode) {
    super(code);
    this.name = "ProtocolViolation";
  }
}

function failure(
  phase: EvalFailurePhase,
  code: EvalFailureCode,
): EvalFailure {
  return { phase, code };
}

function emptyEvidence(requestedFiles: number): SafeEvidence {
  return {
    messages: { system: 0, user: 0, assistant: 0, toolResult: 0 },
    tools: { calls: 0, results: 0, errors: 0 },
    files: { requested: requestedFiles, read: 0 },
    checks: { passed: 0, failed: 0 },
  };
}

function caseIsValid(evalCase: EvalCase): boolean {
  if (
    typeof evalCase.id !== "string" ||
    evalCase.id.trim().length === 0 ||
    typeof evalCase.prompt !== "string" ||
    !Array.isArray(evalCase.files)
  ) {
    return false;
  }
  const files = new Set<string>();
  for (const file of evalCase.files) {
    if (
      typeof file !== "string" ||
      file.trim().length === 0 ||
      files.has(file)
    ) {
      return false;
    }
    files.add(file);
  }
  return (
    typeof evalCase.prepare === "function" &&
    typeof evalCase.judge === "function"
  );
}

function toolCalls(message: AssistantMessage) {
  return message.content.filter(
    (block) => block.type === "toolCall",
  );
}

/**
 * 评测协议只查看 active path，而且只承认已经出现在 assistant message 中的
 * tool call。每个 callId 在整条 path 上唯一，并且恰好有一个同名 result。
 * system message 是合法的 path 成员，但不参与 tool call / result 配对检查。
 */
function assertProtocol(entries: readonly SessionEntry[]): void {
  const messages = entries.flatMap((entry) =>
    entry.type === "message" ? [entry.message] : []
  );
  const calls = new Map<string, { name: string; matched: boolean }>();
  let sawUser = false;
  let interactionOpen = false;
  let interactionHasAssistant = false;

  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      if (interactionOpen && !interactionHasAssistant) {
        throw new ProtocolViolation(
          "incomplete_user_interaction",
        );
      }
      if ([...calls.values()].some((call) => !call.matched)) {
        throw new ProtocolViolation("unpaired_tool_call");
      }
      sawUser = true;
      interactionOpen = true;
      interactionHasAssistant = false;
      continue;
    }

    if (message.role === "assistant") {
      if (!interactionOpen) {
        throw new ProtocolViolation("assistant_without_user");
      }
      if ([...calls.values()].some((call) => !call.matched)) {
        throw new ProtocolViolation("unpaired_tool_call");
      }
      interactionHasAssistant = true;
      for (const call of toolCalls(message)) {
        if (!sawUser) {
          throw new ProtocolViolation("tool_call_without_user");
        }
        if (calls.has(call.id)) {
          throw new ProtocolViolation("duplicate_tool_call");
        }
        calls.set(call.id, { name: call.name, matched: false });
      }
      continue;
    }

    if (!interactionOpen) {
      throw new ProtocolViolation("orphan_tool_result");
    }
    const call = calls.get(message.toolCallId);
    if (!call) {
      throw new ProtocolViolation("orphan_tool_result");
    }
    if (call.matched) {
      throw new ProtocolViolation("duplicate_tool_result");
    }
    if (call.name !== message.toolName) {
      throw new ProtocolViolation("tool_name_mismatch");
    }
    call.matched = true;
  }

  if (!sawUser) {
    throw new ProtocolViolation("missing_user_interaction");
  }
  if (!interactionHasAssistant) {
    throw new ProtocolViolation("incomplete_user_interaction");
  }
  if ([...calls.values()].some((call) => !call.matched)) {
    throw new ProtocolViolation("unpaired_tool_call");
  }
}

function countEvidence(
  entries: readonly SessionEntry[],
  requestedFiles: number,
  readFiles: number,
  checks: readonly boolean[] = [],
): SafeEvidence {
  const evidence = emptyEvidence(requestedFiles);
  evidence.files.read = readFiles;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    evidence.messages[message.role] += 1;
    if (message.role === "assistant") {
      evidence.tools.calls += toolCalls(message).length;
    } else if (message.role === "toolResult") {
      evidence.tools.results += 1;
      if (message.isError) evidence.tools.errors += 1;
    }
  }
  evidence.checks.passed = checks.filter(Boolean).length;
  evidence.checks.failed = checks.length - evidence.checks.passed;
  return evidence;
}

function validVerdict(value: unknown): value is TaskVerdict {
  if (
    value === null ||
    typeof value !== "object" ||
    !("passed" in value) ||
    typeof value.passed !== "boolean" ||
    !("checks" in value) ||
    !Array.isArray(value.checks) ||
    !value.checks.every((check) => typeof check === "boolean")
  ) {
    return false;
  }
  return value.passed === value.checks.every(Boolean);
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return value;
  }
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && "value" in descriptor) {
      deepFreeze(descriptor.value, seen);
    }
  }
  return Object.freeze(value);
}

function frozenObservation(
  result: AgentRunResult,
  entries: readonly SessionEntry[],
  files: Readonly<Record<string, string>>,
): EvalObservation {
  return deepFreeze(structuredClone({ result, entries, files }));
}

function appendCleanupFailure(
  report: EvalReport,
  cleanupFailure: EvalFailure,
): void {
  if (report.primaryFailure) {
    report.secondaryFailures.push(cleanupFailure);
    return;
  }
  report.status = "infra_failed";
  report.primaryFailure = cleanupFailure;
}

function reportWith(
  evalCase: EvalCase,
  evidence: SafeEvidence,
  status: EvalStatus,
  primaryFailure?: EvalFailure,
): EvalReport {
  return {
    id: evalCase.id,
    status,
    evidence,
    ...(primaryFailure ? { primaryFailure } : {}),
    secondaryFailures: [],
  };
}

/**
 * 一次 eval run 只产生一个 primary failure。生命周期错误不能覆盖已经发生的
 * task、protocol 或 infrastructure 事实。
 */
export async function runEvalCase(
  evalCase: EvalCase,
): Promise<EvalReport> {
  const requestedFiles = Array.isArray(evalCase.files)
    ? evalCase.files.length
    : 0;
  let evidence = emptyEvidence(requestedFiles);
  let report = reportWith(evalCase, evidence, "passed");
  let prepared: PreparedEval | undefined;
  let runtime: Runtime | undefined;
  let activeEntries: SessionEntry[] = [];
  let readFiles = 0;

  if (!caseIsValid(evalCase)) {
    return reportWith(
      evalCase,
      evidence,
      "infra_failed",
      failure("prepare", "invalid_case"),
    );
  }

  try {
    try {
      prepared = await evalCase.prepare();
      runtime = prepared.runtime;
      if (
        prepared === null ||
        typeof prepared !== "object" ||
        runtime === null ||
        typeof runtime !== "object" ||
        typeof prepared.readFile !== "function"
      ) {
        throw new Error("invalid prepared eval");
      }
    } catch {
      report = reportWith(
        evalCase,
        evidence,
        "infra_failed",
        failure("prepare", "prepare_failed"),
      );
      return report;
    }

    let result: AgentRunResult;
    try {
      result = await runtime.prompt(evalCase.prompt);
      await runtime.flush();
    } catch {
      report = reportWith(
        evalCase,
        evidence,
        "infra_failed",
        failure("execute", "execute_failed"),
      );
      return report;
    }

    let allEntries: SessionEntry[];
    try {
      allEntries = await runtime.session.entries();
    } catch {
      report = reportWith(
        evalCase,
        evidence,
        "infra_failed",
        failure("collect", "collect_failed"),
      );
      return report;
    }

    const leafId = runtime.getActiveLeafId();
    if (leafId === null) {
      report = reportWith(
        evalCase,
        evidence,
        "protocol_failed",
        failure("protocol", "missing_active_leaf"),
      );
      return report;
    }

    try {
      activeEntries = pathTo(allEntries, leafId);
    } catch {
      report = reportWith(
        evalCase,
        evidence,
        "protocol_failed",
        failure("protocol", "invalid_active_path"),
      );
      return report;
    }
    evidence = countEvidence(
      activeEntries,
      requestedFiles,
      readFiles,
    );

    try {
      assertProtocol(activeEntries);
    } catch (error) {
      const code =
        error instanceof ProtocolViolation
          ? error.code
          : "invalid_active_path";
      report = reportWith(
        evalCase,
        evidence,
        "protocol_failed",
        failure("protocol", code),
      );
      return report;
    }

    const activeMessages = activeEntries.flatMap((entry) =>
      entry.type === "message" ? [entry.message] : []
    );
    if (!isDeepStrictEqual(activeMessages, result.messages)) {
      report = reportWith(
        evalCase,
        evidence,
        "protocol_failed",
        failure("protocol", "result_session_mismatch"),
      );
      return report;
    }

    const files: Record<string, string> = Object.create(null);
    try {
      for (const file of evalCase.files) {
        const content: unknown = await prepared.readFile(file);
        if (typeof content !== "string") {
          throw new Error("readFile must return string");
        }
        files[file] = content;
        readFiles += 1;
      }
    } catch {
      evidence = countEvidence(
        activeEntries,
        requestedFiles,
        readFiles,
      );
      report = reportWith(
        evalCase,
        evidence,
        "infra_failed",
        failure("collect", "collect_failed"),
      );
      return report;
    }

    let observation: EvalObservation;
    try {
      observation = frozenObservation(
        result,
        activeEntries,
        files,
      );
    } catch {
      evidence = countEvidence(
        activeEntries,
        requestedFiles,
        readFiles,
      );
      report = reportWith(
        evalCase,
        evidence,
        "infra_failed",
        failure("collect", "collect_failed"),
      );
      return report;
    }

    let verdict: TaskVerdict;
    try {
      const candidate: unknown = await evalCase.judge(observation);
      if (!validVerdict(candidate)) {
        report = reportWith(
          evalCase,
          countEvidence(
            activeEntries,
            requestedFiles,
            readFiles,
          ),
          "infra_failed",
          failure("judge", "invalid_verdict"),
        );
        return report;
      }
      verdict = candidate;
    } catch {
      report = reportWith(
        evalCase,
        countEvidence(
          activeEntries,
          requestedFiles,
          readFiles,
        ),
        "infra_failed",
        failure("judge", "judge_failed"),
      );
      return report;
    }

    evidence = countEvidence(
      activeEntries,
      requestedFiles,
      readFiles,
      verdict.checks,
    );
    report = verdict.passed
      ? reportWith(evalCase, evidence, "passed")
      : reportWith(
          evalCase,
          evidence,
          "task_failed",
          failure("task", "task_rejected"),
        );
    return report;
  } finally {
    if (runtime) {
      try {
        await runtime.dispose();
      } catch {
        appendCleanupFailure(
          report,
          failure("dispose", "dispose_failed"),
        );
      }
    }
    if (prepared?.cleanup) {
      try {
        await prepared.cleanup();
      } catch {
        appendCleanupFailure(
          report,
          failure("cleanup", "cleanup_failed"),
        );
      }
    }
  }
}

/**
 * suite 故意串行执行：输入顺序就是报告顺序，每个 case 都经由自己的 prepare。
 */
export async function runEvalSuite(
  cases: readonly EvalCase[],
): Promise<EvalReport[]> {
  const reports: EvalReport[] = [];
  for (const evalCase of cases) {
    reports.push(await runEvalCase(evalCase));
  }
  return reports;
}
