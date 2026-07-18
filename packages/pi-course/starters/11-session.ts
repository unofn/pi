import {
  appendFile as appendNodeFile,
  mkdir,
  readFile as readNodeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  AgentMessage,
  AssistantContent,
  AssistantMessage,
  SystemMessage,
  TextContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "./types.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface EntryBase {
  id: string;
  parentId: string | null;
  timestamp: number;
}

export interface MessageSessionEntry extends EntryBase {
  type: "message";
  message: AgentMessage;
}

export interface MetadataSessionEntry extends EntryBase {
  type: "metadata";
  key: string;
  value: JsonValue;
}

export interface CompactionSummary {
  goal: string;
  constraints: string[];
  completed: string[];
  decisions: string[];
  changedFiles: string[];
  unresolved: string[];
  next: string[];
}

export interface CompactionSessionEntry extends EntryBase {
  type: "compaction";
  parentId: string;
  summary: CompactionSummary;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export type SessionEntry =
  | MessageSessionEntry
  | MetadataSessionEntry
  | CompactionSessionEntry;

export interface SessionStore {
  append(entry: SessionEntry): Promise<void>;
  entries(): Promise<SessionEntry[]>;
}

export interface UnterminatedTailWarning {
  code: "unterminated_tail";
  line: number;
}

export interface SessionReadResult {
  entries: SessionEntry[];
  warnings: UnterminatedTailWarning[];
}

export interface SessionFileIO {
  ensureFile(file: string): Promise<void>;
  readFile(file: string): Promise<string>;
  appendFile(file: string, value: string): Promise<void>;
}

const nodeSessionFileIO: SessionFileIO = {
  async ensureFile(file) {
    await mkdir(path.dirname(file), { recursive: true });
    await appendNodeFile(file, "", "utf8");
  },
  readFile(file) {
    return readNodeFile(file, "utf8");
  },
  appendFile(file, value) {
    return appendNodeFile(file, value, "utf8");
  },
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function recordAt(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是 object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} 必须是普通 JSON object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new Error(`${label} 不能包含 symbol 字段`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${label}.${key} 不是可序列化字段`);
    }
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${label} 包含未知字段 ${key}`);
    }
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} 必须是非空 string`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} 必须是 finite number`);
  }
  return value;
}

function jsonValueAt(
  value: unknown,
  label: string,
  ancestors: Set<object> = new Set(),
): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return finiteNumber(value, label);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new Error(`${label} 不能形成循环引用`);
    }
    if (
      Object.getOwnPropertySymbols(value).length > 0 ||
      Object.keys(value).some((key, index) => key !== String(index)) ||
      Object.keys(value).length !== value.length
    ) {
      throw new Error(`${label} 必须是连续的 JSON array`);
    }
    ancestors.add(value);
    const result = value.map((item, index) =>
      jsonValueAt(item, `${label}[${index}]`, ancestors)
    );
    ancestors.delete(value);
    return result;
  }
  const record = recordAt(value, label);
  if (ancestors.has(record)) {
    throw new Error(`${label} 不能形成循环引用`);
  }
  ancestors.add(record);
  const result: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(record)) {
    result[key] = jsonValueAt(item, `${label}.${key}`, ancestors);
  }
  ancestors.delete(record);
  return result;
}

function textContentAt(value: unknown, label: string): TextContent {
  const record = recordAt(value, label);
  exactKeys(record, ["type", "text"], label);
  if (record.type !== "text") {
    throw new Error(`${label}.type 必须是 text`);
  }
  if (typeof record.text !== "string") {
    throw new Error(`${label}.text 必须是 string`);
  }
  return { type: "text", text: record.text };
}

function toolCallAt(value: unknown, label: string): ToolCall {
  const record = recordAt(value, label);
  exactKeys(
    record,
    ["type", "id", "name", "arguments", "rawArguments"],
    label,
  );
  if (record.type !== "toolCall") {
    throw new Error(`${label}.type 必须是 toolCall`);
  }
  const call: ToolCall = {
    type: "toolCall",
    id: nonEmptyString(record.id, `${label}.id`),
    name: nonEmptyString(record.name, `${label}.name`),
    arguments: jsonValueAt(record.arguments, `${label}.arguments`),
  };
  if (own(record, "rawArguments")) {
    if (typeof record.rawArguments !== "string") {
      throw new Error(`${label}.rawArguments 必须是 string`);
    }
    call.rawArguments = record.rawArguments;
  }
  return call;
}

function assistantContentAt(
  value: unknown,
  label: string,
): AssistantContent {
  const record = recordAt(value, label);
  if (record.type === "text") return textContentAt(record, label);
  if (record.type === "toolCall") return toolCallAt(record, label);
  throw new Error(`${label}.type 不是已知 content block`);
}

function usageAt(value: unknown, label: string): Usage {
  const record = recordAt(value, label);
  exactKeys(record, ["input", "output", "totalTokens"], label);
  const input = finiteNumber(record.input, `${label}.input`);
  const output = finiteNumber(record.output, `${label}.output`);
  const totalTokens = finiteNumber(
    record.totalTokens,
    `${label}.totalTokens`,
  );
  if (input < 0 || output < 0 || totalTokens < 0) {
    throw new Error(`${label} 的 token 数不能小于 0`);
  }
  return { input, output, totalTokens };
}

function timestampAt(value: unknown, label: string): number {
  return finiteNumber(value, `${label}.timestamp`);
}

/**
 * system message 就是普通 message entry，没有新的 entry 类型。content 必须是
 * string；sections 的每个值只能是 string 或 null（null 表示删除段落）。
 */
function systemMessageAt(
  record: Record<string, unknown>,
  label: string,
): SystemMessage {
  exactKeys(record, ["role", "content", "sections", "timestamp"], label);
  if (typeof record.content !== "string") {
    throw new Error(`${label}.content 必须是 string`);
  }
  const message: SystemMessage = {
    role: "system",
    content: record.content,
    timestamp: timestampAt(record.timestamp, label),
  };
  if (own(record, "sections")) {
    const sections = recordAt(record.sections, `${label}.sections`);
    const parsed: Record<string, string | null> = {};
    for (const [name, value] of Object.entries(sections)) {
      if (value !== null && typeof value !== "string") {
        throw new Error(
          `${label}.sections.${name} 必须是 string 或 null`,
        );
      }
      parsed[name] = value;
    }
    message.sections = parsed;
  }
  return message;
}

function userMessageAt(
  record: Record<string, unknown>,
  label: string,
): UserMessage {
  exactKeys(record, ["role", "content", "timestamp"], label);
  if (!Array.isArray(record.content)) {
    throw new Error(`${label}.content 必须是 array`);
  }
  return {
    role: "user",
    content: record.content.map((block, index) =>
      textContentAt(block, `${label}.content[${index}]`)
    ),
    timestamp: timestampAt(record.timestamp, label),
  };
}

function assistantMessageAt(
  record: Record<string, unknown>,
  label: string,
): AssistantMessage {
  exactKeys(
    record,
    [
      "role",
      "content",
      "provider",
      "model",
      "usage",
      "stopReason",
      "errorMessage",
      "timestamp",
    ],
    label,
  );
  if (!Array.isArray(record.content)) {
    throw new Error(`${label}.content 必须是 array`);
  }
  if (typeof record.provider !== "string") {
    throw new Error(`${label}.provider 必须是 string`);
  }
  if (typeof record.model !== "string") {
    throw new Error(`${label}.model 必须是 string`);
  }
  const stopReasons = new Set([
    "stop",
    "length",
    "toolUse",
    "error",
    "aborted",
  ]);
  if (typeof record.stopReason !== "string" ||
      !stopReasons.has(record.stopReason)) {
    throw new Error(`${label}.stopReason 不是已知终态`);
  }
  const message: AssistantMessage = {
    role: "assistant",
    content: record.content.map((block, index) =>
      assistantContentAt(block, `${label}.content[${index}]`)
    ),
    provider: record.provider,
    model: record.model,
    usage: usageAt(record.usage, `${label}.usage`),
    stopReason: record.stopReason as AssistantMessage["stopReason"],
    timestamp: timestampAt(record.timestamp, label),
  };
  if (own(record, "errorMessage")) {
    if (typeof record.errorMessage !== "string") {
      throw new Error(`${label}.errorMessage 必须是 string`);
    }
    message.errorMessage = record.errorMessage;
  }
  return message;
}

function toolResultMessageAt(
  record: Record<string, unknown>,
  label: string,
): ToolResultMessage {
  exactKeys(
    record,
    [
      "role",
      "toolCallId",
      "toolName",
      "content",
      "details",
      "isError",
      "timestamp",
    ],
    label,
  );
  if (!Array.isArray(record.content)) {
    throw new Error(`${label}.content 必须是 array`);
  }
  if (typeof record.isError !== "boolean") {
    throw new Error(`${label}.isError 必须是 boolean`);
  }
  const message: ToolResultMessage = {
    role: "toolResult",
    toolCallId: nonEmptyString(
      record.toolCallId,
      `${label}.toolCallId`,
    ),
    toolName: nonEmptyString(record.toolName, `${label}.toolName`),
    content: record.content.map((block, index) =>
      textContentAt(block, `${label}.content[${index}]`)
    ),
    isError: record.isError,
    timestamp: timestampAt(record.timestamp, label),
  };
  if (own(record, "details")) {
    message.details = jsonValueAt(record.details, `${label}.details`);
  }
  return message;
}

function agentMessageAt(value: unknown, label: string): AgentMessage {
  const record = recordAt(value, label);
  if (record.role === "system") return systemMessageAt(record, label);
  if (record.role === "user") return userMessageAt(record, label);
  if (record.role === "assistant") {
    return assistantMessageAt(record, label);
  }
  if (record.role === "toolResult") {
    return toolResultMessageAt(record, label);
  }
  throw new Error(`${label}.role 不是已知 AgentMessage`);
}

function entryBaseAt(
  record: Record<string, unknown>,
): EntryBase {
  const id = nonEmptyString(record.id, "session entry.id");
  let parentId: string | null;
  if (record.parentId === null) {
    parentId = null;
  } else {
    parentId = nonEmptyString(
      record.parentId,
      `session entry ${id}.parentId`,
    );
  }
  return {
    id,
    parentId,
    timestamp: finiteNumber(
      record.timestamp,
      `session entry ${id}.timestamp`,
    ),
  };
}

function labError(lab: string): Error {
  return new Error(`${lab} 尚未实现`);
}

/**
 * Chapter 10 的 message/metadata parser 保持完整；本章只留下 compaction
 * variant 的逐层运行时收窄。
 */
export function parseSessionEntry(value: unknown): SessionEntry {
  const record = recordAt(value, "session entry");
  const base = entryBaseAt(record);
  if (record.type === "message") {
    exactKeys(
      record,
      ["id", "parentId", "timestamp", "type", "message"],
      `session entry ${base.id}`,
    );
    if (!own(record, "message")) {
      throw new Error(`session entry ${base.id} 缺少 message payload`);
    }
    return {
      ...base,
      type: "message",
      message: agentMessageAt(
        record.message,
        `session entry ${base.id}.message`,
      ),
    };
  }
  if (record.type === "metadata") {
    exactKeys(
      record,
      ["id", "parentId", "timestamp", "type", "key", "value"],
      `session entry ${base.id}`,
    );
    if (!own(record, "value")) {
      throw new Error(`session entry ${base.id} 缺少 metadata value`);
    }
    return {
      ...base,
      type: "metadata",
      key: nonEmptyString(
        record.key,
        `session entry ${base.id}.key`,
      ),
      value: jsonValueAt(
        record.value,
        `session entry ${base.id}.value`,
      ),
    };
  }
  if (record.type === "compaction") {
    throw labError("Lab 11.1 compaction entry");
  }
  throw new Error(
    `session entry ${base.id}.type 不是 message、metadata 或 compaction`,
  );
}

export function recoverJsonl(value: string): SessionReadResult {
  const lines = value.split("\n");
  const warnings: UnterminatedTailWarning[] = [];
  const hasUnterminatedTail =
    !value.endsWith("\n") && lines.at(-1)?.trim().length !== 0;
  const committedLineCount =
    hasUnterminatedTail ? lines.length - 1 : lines.length;

  if (hasUnterminatedTail) {
    warnings.push({
      code: "unterminated_tail",
      line: lines.length,
    });
  }

  const entries: SessionEntry[] = [];
  for (let index = 0; index < committedLineCount; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `session JSONL 第 ${index + 1} 行不是合法 JSON：${describe(error)}`,
        { cause: error },
      );
    }
    try {
      entries.push(parseSessionEntry(parsed));
    } catch (error) {
      throw new Error(
        `session JSONL 第 ${index + 1} 行不是合法 session entry：${describe(error)}`,
        { cause: error },
      );
    }
  }
  return { entries, warnings };
}

function validateNextEntry(
  entry: SessionEntry,
  ids: ReadonlySet<string>,
): void {
  if (ids.has(entry.id)) {
    throw new Error(`session entry id 重复：${entry.id}`);
  }
  if (entry.parentId !== null && !ids.has(entry.parentId)) {
    throw new Error(
      `session entry ${entry.id} 的 parent ${entry.parentId} 尚不存在`,
    );
  }
}

function idsFromCommittedEntries(
  entries: readonly SessionEntry[],
): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    validateNextEntry(entry, ids);
    ids.add(entry.id);
  }
  return ids;
}

function rejected(error: unknown): Promise<never> {
  return Promise.reject(error);
}

export class InMemorySessionStore implements SessionStore {
  private readonly log: SessionEntry[] = [];
  private readonly ids = new Set<string>();
  private tail: Promise<void> = Promise.resolve();

  append(entry: SessionEntry): Promise<void> {
    let snapshot: SessionEntry;
    try {
      snapshot = parseSessionEntry(entry);
    } catch (error) {
      return rejected(error);
    }
    const operation = this.tail.then(() => {
      validateNextEntry(snapshot, this.ids);
      this.log.push(snapshot);
      this.ids.add(snapshot.id);
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async entries(): Promise<SessionEntry[]> {
    await this.tail;
    return structuredClone(this.log);
  }
}

export class JsonlSessionStore implements SessionStore {
  private tail: Promise<void> = Promise.resolve();
  private tainted = false;
  private taintCause: unknown;

  private constructor(
    private readonly file: string,
    private readonly io: SessionFileIO,
    private readonly ids: Set<string>,
    private readonly repairWarning?: UnterminatedTailWarning,
  ) {}

  static async open(
    file: string,
    io: SessionFileIO = nodeSessionFileIO,
  ): Promise<JsonlSessionStore> {
    await io.ensureFile(file);
    const recovered = recoverJsonl(await io.readFile(file));
    return new JsonlSessionStore(
      file,
      io,
      idsFromCommittedEntries(recovered.entries),
      recovered.warnings[0],
    );
  }

  append(entry: SessionEntry): Promise<void> {
    if (this.tainted) return rejected(this.taintCause);
    if (this.repairWarning) {
      return rejected(
        new Error(
          `session 文件第 ${this.repairWarning.line} 行有未提交尾部；修复前不能 append`,
        ),
      );
    }

    let snapshot: SessionEntry;
    let serialized: string;
    try {
      snapshot = parseSessionEntry(entry);
      serialized = `${JSON.stringify(snapshot)}\n`;
    } catch (error) {
      return rejected(error);
    }

    const operation = this.tail.then(async () => {
      if (this.tainted) throw this.taintCause;
      validateNextEntry(snapshot, this.ids);
      try {
        await this.io.appendFile(this.file, serialized);
      } catch (error) {
        this.tainted = true;
        this.taintCause = error;
        throw error;
      }
      this.ids.add(snapshot.id);
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async entries(): Promise<SessionEntry[]> {
    return (await this.read()).entries;
  }

  async read(): Promise<SessionReadResult> {
    await this.tail;
    if (this.tainted) throw this.taintCause;
    return recoverJsonl(await this.io.readFile(this.file));
  }
}

export function pathTo(
  entries: readonly SessionEntry[],
  leafId: string,
): SessionEntry[] {
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) {
      throw new Error(`session entry id 重复：${entry.id}`);
    }
    byId.set(entry.id, entry);
  }

  let current = byId.get(leafId);
  if (!current) {
    throw new Error(`未知 session leaf：${leafId}`);
  }

  const reverse: SessionEntry[] = [];
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current.id)) {
      throw new Error(`session parent 在 ${current.id} 形成环`);
    }
    visited.add(current.id);
    reverse.push(current);
    if (current.parentId === null) break;
    const parentId = current.parentId;
    const childId = current.id;
    current = byId.get(parentId);
    if (!current) {
      throw new Error(
        `session entry ${childId} 的 parent ${parentId} 缺失`,
      );
    }
  }
  return reverse.reverse().map((entry) => parseSessionEntry(entry));
}

export function messagesOnPath(
  entries: readonly SessionEntry[],
  leafId: string,
): AgentMessage[] {
  return pathTo(entries, leafId).flatMap((entry) =>
    entry.type === "message" ? [structuredClone(entry.message)] : []
  );
}
