import type {
  CompactionSessionEntry,
  CompactionSummary,
  MessageSessionEntry,
  SessionEntry,
} from "./session.js";
import type { AgentMessage } from "./types.js";

export interface InteractionGroup {
  entries: MessageSessionEntry[];
}

export interface BuildContextOptions {
  maxTokens: number;
  reservedOutput: number;
  safetyMargin: number;
  estimateTokens(value: string | AgentMessage): number;
}

export type ContextBuildReason =
  | "within_budget"
  | "trimmed"
  | "single_group_overflow";

export interface ContextTokenProjection {
  maxTokens: number;
  system: number;
  messages: number;
  reservedOutput: number;
  safetyMargin: number;
  availableForMessages: number;
  total: number;
}

/**
 * messages = [当前 system message?, compaction 摘要?, ...保留的后缀]。
 */
export interface BuildContextResult {
  messages: AgentMessage[];
  keptEntryIds: string[];
  reason: ContextBuildReason;
  tokens: ContextTokenProjection;
}

export interface CreateCompactionInput {
  id: string;
  timestamp: number;
  summary: CompactionSummary;
  firstKeptEntryId: string;
  tokensBefore: number;
}

function labError(lab: string): Error {
  return new Error(`${lab} 尚未实现`);
}

/**
 * 这是 Chapter 11 的 context 学习脚手架，不是参考实现。
 *
 * 公共输入和输出已经固定。interaction 配对、预算选择、纯 compaction
 * 创建，以及从最新 compaction 恢复，都留给对应实验。
 */
export function groupInteractions(
  _entries: readonly MessageSessionEntry[],
): InteractionGroup[] {
  throw labError("Lab 11.2 interaction groups");
}

export function buildContext(
  activePath: readonly SessionEntry[],
  _options: BuildContextOptions,
): BuildContextResult {
  if (activePath.some((entry) => entry.type === "compaction")) {
    throw labError("Lab 11.5 resume compaction");
  }
  throw labError("Lab 11.3 budget projection");
}

export function createCompactionEntry(
  _activePath: readonly SessionEntry[],
  _input: CreateCompactionInput,
): CompactionSessionEntry {
  throw labError("Lab 11.4 create compaction");
}
