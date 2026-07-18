import type { AgentMessage } from "./types.js";

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

export type SessionEntry =
  | MessageSessionEntry
  | MetadataSessionEntry;

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

function labError(lab: string): Error {
  return new Error(`${lab} 尚未实现`);
}

/**
 * 这是 Chapter 10 的学习脚手架，不是参考实现。
 *
 * 它只固定 session entry、store、JSONL recovery 和 active-path projection
 * 的公共表面。校验、所有权、队列、故障状态机和路径算法仍由六段实验完成。
 */
export function parseSessionEntry(_value: unknown): SessionEntry {
  // Lab 10.2：逐层把外部 unknown 收窄成 message 或 metadata。
  throw labError("Lab 10.2 parseSessionEntry");
}

export function recoverJsonl(_value: string): SessionReadResult {
  // Lab 10.4：只恢复以换行符提交的完整 JSONL 行。
  throw labError("Lab 10.4 recoverJsonl");
}

export class InMemorySessionStore implements SessionStore {
  append(_entry: SessionEntry): Promise<void> {
    // Lab 10.3：调用时取快照，再按 FIFO 验证并提交。
    return Promise.reject(labError("Lab 10.3 InMemory append"));
  }

  entries(): Promise<SessionEntry[]> {
    // Lab 10.3：等待当前队列后返回深副本。
    return Promise.reject(labError("Lab 10.3 InMemory entries"));
  }
}

export class JsonlSessionStore implements SessionStore {
  static async open(
    _file: string,
    _io?: SessionFileIO,
  ): Promise<JsonlSessionStore> {
    // Lab 10.5：验证已提交前缀，并建立 ready 或 needs-repair 状态。
    throw labError("Lab 10.5 Jsonl open");
  }

  append(_entry: SessionEntry): Promise<void> {
    // Lab 10.5：调用时序列化，单实例 FIFO append，I/O 失败后 fail-closed。
    return Promise.reject(labError("Lab 10.5 Jsonl append"));
  }

  entries(): Promise<SessionEntry[]> {
    // Lab 10.5：只读恢复不能绕过 tainted writer。
    return Promise.reject(labError("Lab 10.5 Jsonl entries"));
  }

  read(): Promise<SessionReadResult> {
    // Lab 10.5：返回 entries 和结构化 recovery warnings。
    return Promise.reject(labError("Lab 10.5 Jsonl read"));
  }
}

export function pathTo(
  _entries: readonly SessionEntry[],
  _leafId: string,
): SessionEntry[] {
  // Lab 10.1：沿 parent pointer 选择唯一活动路径。
  throw labError("Lab 10.1 pathTo");
}

export function messagesOnPath(
  _entries: readonly SessionEntry[],
  _leafId: string,
): AgentMessage[] {
  // Lab 10.6：跳过 metadata，完整投影 canonical messages。
  throw labError("Lab 10.6 messagesOnPath");
}
