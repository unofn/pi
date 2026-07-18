import type { AgentRunResult } from "../src/agent-loop.js";
import type { Runtime } from "../src/composition.js";
import type { SessionEntry } from "../src/session.js";

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
  readonly entries: readonly SessionEntry[];
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

function labError(lab: string): Error {
  return new Error(`${lab} 尚未实现`);
}

/**
 * 这是 Chapter 14 的学习脚手架，不是参考实现。
 *
 * 公共类型已经固定。隔离执行、协议校验、失败分层、观察值冻结、证据脱敏
 * 与 cleanup 主次规则都留给三段公开实验。
 */
export async function runEvalCase(
  _evalCase: EvalCase,
): Promise<EvalReport> {
  throw labError("Lab 14.1 runEvalCase");
}

export async function runEvalSuite(
  _cases: readonly EvalCase[],
): Promise<EvalReport[]> {
  throw labError("Lab 14.3 runEvalSuite");
}
