import {
  parseSessionEntry,
  type CompactionSessionEntry,
  type CompactionSummary,
  type MessageSessionEntry,
  type SessionEntry,
} from "./session.js";
import {
  currentSystemMessage,
  text,
  type AgentMessage,
  type SystemMessage,
  type ToolCall,
  type UserMessage,
} from "./types.js";

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
 * system message 从整条 active path 重放而来，不属于任何 interaction。
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneMessageEntry(
  entry: MessageSessionEntry,
): MessageSessionEntry {
  const parsed = parseSessionEntry(entry);
  if (parsed.type !== "message") {
    throw new Error(`session entry ${entry.id} 不是 message`);
  }
  return parsed;
}

function callsIn(entry: MessageSessionEntry): ToolCall[] {
  if (entry.message.role !== "assistant") return [];
  return entry.message.content.filter(
    (block): block is ToolCall => block.type === "toolCall",
  );
}

function validateInteraction(group: InteractionGroup): void {
  const calls = new Map<string, string>();
  const results = new Map<string, string>();

  for (const entry of group.entries) {
    for (const call of callsIn(entry)) {
      const previous = calls.get(call.id);
      if (previous) {
        throw new Error(
          `interaction 中 tool call ${call.id} 重复：${previous} 与 ${entry.id}`,
        );
      }
      calls.set(call.id, entry.id);
    }
    if (entry.message.role === "toolResult") {
      const callId = entry.message.toolCallId;
      const previous = results.get(callId);
      if (previous) {
        throw new Error(
          `interaction 中 tool result ${callId} 重复：${previous} 与 ${entry.id}`,
        );
      }
      results.set(callId, entry.id);
    }
  }

  for (const [callId, resultEntryId] of results) {
    if (!calls.has(callId)) {
      throw new Error(
        `tool result ${resultEntryId} 引用了不存在的 call ${callId}`,
      );
    }
  }
  for (const [callId, callEntryId] of calls) {
    if (!results.has(callId)) {
      throw new Error(
        `tool call ${callId}（entry ${callEntryId}）缺少 result`,
      );
    }
  }
}

/**
 * 一个 user message 开始一个 interaction。工具结果按 callId 配对，
 * 不依赖 tool result 在数组中的相邻位置或完成顺序。system message 不属于
 * 任何 interaction：它们由 system 重放单独处理，这里直接跳过。
 */
export function groupInteractions(
  entries: readonly MessageSessionEntry[],
): InteractionGroup[] {
  const groups: InteractionGroup[] = [];
  let current: InteractionGroup | undefined;

  const finishCurrent = (): void => {
    if (!current) return;
    validateInteraction(current);
    groups.push(current);
    current = undefined;
  };

  for (const source of entries) {
    const entry = cloneMessageEntry(source);
    if (entry.message.role === "system") continue;
    if (entry.message.role === "user") {
      finishCurrent();
      current = { entries: [entry] };
      continue;
    }
    if (!current) {
      throw new Error(
        `message entry ${entry.id} 在第一个 user interaction 之前`,
      );
    }
    current.entries.push(entry);
  }
  finishCurrent();
  return structuredClone(groups);
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} 必须是非负 finite number`);
  }
  return value;
}

function estimatedTokens(
  options: BuildContextOptions,
  value: string | AgentMessage,
  label: string,
): number {
  let estimate: number;
  try {
    estimate = options.estimateTokens(
      typeof value === "string" ? value : structuredClone(value),
    );
  } catch (error) {
    throw new Error(`${label} token 估算失败：${describe(error)}`, {
      cause: error,
    });
  }
  return nonNegativeFinite(estimate, `${label} token 估算`);
}

function summaryLines(label: string, values: readonly string[]): string[] {
  return [
    `${label}：`,
    ...(values.length === 0
      ? ["- （无）"]
      : values.map((value) => `- ${value}`)),
  ];
}

function compactionSummaryText(summary: CompactionSummary): string {
  return [
    "【会话压缩摘要】",
    `目标：${summary.goal}`,
    ...summaryLines("约束", summary.constraints),
    ...summaryLines("已完成", summary.completed),
    ...summaryLines("决策", summary.decisions),
    ...summaryLines("变更文件", summary.changedFiles),
    ...summaryLines("未解决", summary.unresolved),
    ...summaryLines("下一步", summary.next),
  ].join("\n");
}

function summaryMessage(
  compaction: CompactionSessionEntry,
): UserMessage {
  return {
    role: "user",
    content: [text(compactionSummaryText(compaction.summary))],
    timestamp: compaction.timestamp,
  };
}

function latestCompaction(
  activePath: readonly SessionEntry[],
): { entry: CompactionSessionEntry; index: number } | undefined {
  for (let index = activePath.length - 1; index >= 0; index -= 1) {
    const candidate = activePath[index];
    if (candidate?.type !== "compaction") continue;
    const parsed = parseSessionEntry(candidate);
    if (parsed.type !== "compaction") {
      throw new Error(`session entry ${candidate.id} 不是 compaction`);
    }
    return { entry: parsed, index };
  }
  return undefined;
}

function messageCandidates(
  activePath: readonly SessionEntry[],
  compaction:
    | { entry: CompactionSessionEntry; index: number }
    | undefined,
): MessageSessionEntry[] {
  let startIndex = 0;
  if (compaction) {
    startIndex = activePath.findIndex(
      (entry) => entry.id === compaction.entry.firstKeptEntryId,
    );
    if (startIndex < 0 || startIndex >= compaction.index) {
      throw new Error(
        `compaction ${compaction.entry.id} 的 firstKeptEntryId ${compaction.entry.firstKeptEntryId} 不在它之前`,
      );
    }
    const first = activePath[startIndex];
    if (first?.type !== "message" || first.message.role !== "user") {
      throw new Error(
        `compaction ${compaction.entry.id} 的 firstKeptEntryId ${compaction.entry.firstKeptEntryId} 不是 interaction 起点`,
      );
    }
  }
  return activePath
    .slice(startIndex)
    .filter(
      (entry): entry is MessageSessionEntry =>
        entry.type === "message",
    );
}

/**
 * 从整条 active path（包括 compaction 之前的部分）收集 system message，
 * 重放成一条当前 system message。compaction 不改写 system 状态，所以跨越
 * 边界重放整条路径就能得到同样结果。
 */
function replayedSystemMessage(
  activePath: readonly SessionEntry[],
): SystemMessage | undefined {
  return currentSystemMessage(
    activePath.flatMap((entry) =>
      entry.type === "message" ? [entry.message] : []
    ),
  );
}

/**
 * 固定成本先扣 system、输出预留和安全余量；剩余预算只在完整 interaction
 * 边界选择最近的连续尾部。最新 interaction 即使单独超限也不会被拆开。
 */
export function buildContext(
  activePath: readonly SessionEntry[],
  options: BuildContextOptions,
): BuildContextResult {
  const maxTokens = nonNegativeFinite(
    options.maxTokens,
    "maxTokens",
  );
  const reservedOutput = nonNegativeFinite(
    options.reservedOutput,
    "reservedOutput",
  );
  const safetyMargin = nonNegativeFinite(
    options.safetyMargin,
    "safetyMargin",
  );
  const systemMessage = replayedSystemMessage(activePath);
  const system = systemMessage === undefined
    ? 0
    : estimatedTokens(options, systemMessage, "system message");
  const availableForMessages = Math.max(
    0,
    maxTokens - system - reservedOutput - safetyMargin,
  );

  const compaction = latestCompaction(activePath);
  const groups = groupInteractions(
    messageCandidates(activePath, compaction),
  );
  if (
    compaction &&
    groups[0]?.entries[0]?.id !==
      compaction.entry.firstKeptEntryId
  ) {
    throw new Error(
      `compaction ${compaction.entry.id} 的 firstKeptEntryId ${compaction.entry.firstKeptEntryId} 不是完整 interaction 的首条 message`,
    );
  }

  const fixedMessages = compaction
    ? [summaryMessage(compaction.entry)]
    : [];
  const fixedCost = fixedMessages.reduce(
    (total, message, index) =>
      total +
      estimatedTokens(
        options,
        message,
        `compaction summary ${index + 1}`,
      ),
    0,
  );
  const groupBudget = Math.max(0, availableForMessages - fixedCost);
  const groupCosts = groups.map((group, groupIndex) =>
    group.entries.reduce(
      (total, entry, entryIndex) =>
        total +
        estimatedTokens(
          options,
          entry.message,
          `interaction ${groupIndex + 1} message ${entryIndex + 1}`,
        ),
      0,
    )
  );

  let firstSelected = groups.length;
  let selectedGroupCost = 0;
  let reason: ContextBuildReason = "within_budget";
  if (groups.length > 0) {
    const latestIndex = groups.length - 1;
    firstSelected = latestIndex;
    selectedGroupCost = groupCosts[latestIndex] ?? 0;
    if (selectedGroupCost > groupBudget) {
      reason = "single_group_overflow";
    } else {
      for (let index = latestIndex - 1; index >= 0; index -= 1) {
        const candidateCost = groupCosts[index] ?? 0;
        if (selectedGroupCost + candidateCost > groupBudget) {
          reason = "trimmed";
          break;
        }
        selectedGroupCost += candidateCost;
        firstSelected = index;
      }
      if (firstSelected > 0) reason = "trimmed";
    }
  }

  const selectedEntries = groups
    .slice(firstSelected)
    .flatMap((group) => group.entries);
  const messages: AgentMessage[] = [
    ...(systemMessage ? [systemMessage] : []),
    ...fixedMessages,
    ...selectedEntries.map((entry) => entry.message),
  ];
  const messageTokens = fixedCost + selectedGroupCost;
  return {
    messages: structuredClone(messages),
    keptEntryIds: selectedEntries.map((entry) => entry.id),
    reason,
    tokens: {
      maxTokens,
      system,
      messages: messageTokens,
      reservedOutput,
      safetyMargin,
      availableForMessages,
      total: system + messageTokens + reservedOutput + safetyMargin,
    },
  };
}

/**
 * 只创建一条可追加的 compaction 事实；不改历史，也不写 store。
 */
export function createCompactionEntry(
  activePath: readonly SessionEntry[],
  input: CreateCompactionInput,
): CompactionSessionEntry {
  const parent = activePath.at(-1);
  if (!parent) {
    throw new Error("空 active path 不能创建 compaction");
  }
  if (activePath.some((entry) => entry.id === input.id)) {
    throw new Error(`session entry id 重复：${input.id}`);
  }

  const groups = groupInteractions(
    activePath.filter(
      (entry): entry is MessageSessionEntry =>
        entry.type === "message",
    ),
  );
  const firstKeptIsGroupStart = groups.some(
    (group) => group.entries[0]?.id === input.firstKeptEntryId,
  );
  if (!firstKeptIsGroupStart) {
    throw new Error(
      `firstKeptEntryId ${input.firstKeptEntryId} 必须是完整 interaction 的首条 message`,
    );
  }

  const parsed = parseSessionEntry({
    id: input.id,
    parentId: parent.id,
    timestamp: input.timestamp,
    type: "compaction",
    summary: input.summary,
    firstKeptEntryId: input.firstKeptEntryId,
    tokensBefore: input.tokensBefore,
  });
  if (parsed.type !== "compaction") {
    throw new Error(`无法创建 compaction ${input.id}`);
  }
  return parsed;
}
