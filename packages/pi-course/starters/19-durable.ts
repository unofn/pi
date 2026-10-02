import type { JsonValue } from "./session.js";
import { executeToolCall, ToolRegistry, type Tool } from "./tool.js";
import {
  assistantMessage,
  userMessage,
  type AgentMessage,
  type AssistantMessage,
  type Model,
  type ToolCall,
  type ToolResultMessage,
  type UserMessage,
} from "./types.js";

/* ------------------------------------------------------------------ */
/* Lab 19.1 · 先提交，再可见：原子批量存储与单一变更线                     */
/* ------------------------------------------------------------------ */

/**
 * 这是 Chapter 19 的学习脚手架，不是参考实现。存储与会话的读取、任务与 entry 的
 * 记录形状、prompt、生成的流式提交与工具的 execute/settle 已经给出；原子提交与单一
 * 变更线（Lab 19.1）、打开与调度（Lab 19.2）、工具意图与回放（Lab 19.3）、部分输出
 * 恢复（Lab 19.4）留空。
 */
function labError(lab: string): Error {
  return new Error(`${lab} 尚未实现`);
}

export type DurableCollection = "entries" | "tasks";

/** 一次提交里的一条写入：按 id 整条替换。 */
export interface DurableWrite {
  collection: DurableCollection;
  id: string;
  value: JsonValue;
}

export interface DurableSnapshot {
  seq: number;
  entries: Record<string, JsonValue>;
  tasks: Record<string, JsonValue>;
}

export class StorageRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageRejected";
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

/**
 * 内存存储。一次 commit 是一个原子批量写：先检查整批，有一条不合法就整批拒绝
 * （StorageRejected），一条都不落；通过后一起写入并分配递增的 seq。快照可以
 * 导出再导入，用来模拟进程重启。
 */
export class DurableStore {
  private seq = 0;
  private readonly collections: Record<DurableCollection, Map<string, JsonValue>> = {
    entries: new Map(),
    tasks: new Map(),
  };
  private readonly listeners = new Set<(seq: number, writes: readonly DurableWrite[]) => void>();
  private tail: Promise<void> = Promise.resolve();

  static fromSnapshot(snapshot: DurableSnapshot): DurableStore {
    const store = new DurableStore();
    store.seq = snapshot.seq;
    for (const [id, value] of Object.entries(snapshot.entries)) {
      store.collections.entries.set(id, structuredClone(value));
    }
    for (const [id, value] of Object.entries(snapshot.tasks)) {
      store.collections.tasks.set(id, structuredClone(value));
    }
    return store;
  }

  commit(_writes: readonly DurableWrite[]): Promise<number> {
    // Lab 19.1：排在 tail 上；先整批检查（collection、非空 id、isJsonValue），任一不合法抛
    // StorageRejected 且一条都不写；通过后深复制写入、seq += 1、通知 listeners、返回 seq。
    void isJsonValue;
    return Promise.reject(labError("Lab 19.1 DurableStore.commit"));
  }

  get currentSeq(): number {
    return this.seq;
  }

  get(collection: DurableCollection, id: string): JsonValue | undefined {
    const value = this.collections[collection].get(id);
    return value === undefined ? undefined : structuredClone(value);
  }

  list(collection: DurableCollection): { id: string; value: JsonValue }[] {
    return [...this.collections[collection]].map(([id, value]) => ({
      id,
      value: structuredClone(value),
    }));
  }

  snapshot(): DurableSnapshot {
    return structuredClone({
      seq: this.seq,
      entries: Object.fromEntries(this.collections.entries),
      tasks: Object.fromEntries(this.collections.tasks),
    });
  }

  /** 每次成功提交后同步调用；测试用它在第 N 次提交后拍快照。 */
  onCommit(listener: (seq: number, writes: readonly DurableWrite[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** change 里能看到的、已提交的状态，以及本次要写的东西。 */
export interface Transaction {
  get(collection: DurableCollection, id: string): JsonValue | undefined;
  list(collection: DurableCollection): { id: string; value: JsonValue }[];
  put(collection: DurableCollection, id: string, value: JsonValue): void;
}

/**
 * 单一变更线：所有提交排在一条 promise 链上，一次只有一个 change 在跑。change
 * 只收集写入；它返回后整批交给存储，存储成功后才更新可见状态（adopt）。change
 * 抛错或存储拒绝都不留下任何可见进展。副作用（调模型、跑工具）绝不在 change 里做。
 */
export class DurableSession {
  private readonly view: Record<DurableCollection, Map<string, JsonValue>> = {
    entries: new Map(),
    tasks: new Map(),
  };
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly store: DurableStore) {
    for (const collection of ["entries", "tasks"] as const) {
      for (const { id, value } of store.list(collection)) {
        this.view[collection].set(id, value);
      }
    }
  }

  get(collection: DurableCollection, id: string): JsonValue | undefined {
    const value = this.view[collection].get(id);
    return value === undefined ? undefined : structuredClone(value);
  }

  list(collection: DurableCollection): { id: string; value: JsonValue }[] {
    return [...this.view[collection]].map(([id, value]) => ({
      id,
      value: structuredClone(value),
    }));
  }

  commit<T>(_change: (tx: Transaction) => T | Promise<T>): Promise<T> {
    // Lab 19.1：排在 tail 上；tx.get/list 读 view，tx.put 只收集；change 返回后没有写入则直接返回，
    // 否则 store.commit(writes) 成功后再把写入 adopt 进 view。change 抛错或存储拒绝都不改 view。
    return Promise.reject(labError("Lab 19.1 DurableSession.commit"));
  }
}

/* ------------------------------------------------------------------ */
/* Lab 19.2 · 任务：pending → running → completed | failed               */
/* ------------------------------------------------------------------ */

export type DurableEntry =
  | { type: "user"; message: UserMessage }
  | { type: "assistant"; message: AssistantMessage }
  | { type: "toolResult"; message: ToolResultMessage };

export interface EntryRecord {
  id: string;
  conversationId: string;
  /** 会话内的顺序号。 */
  index: number;
  entry: DurableEntry;
}

export type TaskStatus = "pending" | "running" | "completed" | "failed";

export type ReplayPolicy = "safe" | "unsafe";

export type GenerationCheckpoint = {
  phase: "request";
  /** 已提交的部分输出；崩溃恢复时变成 aborted entry。 */
  partial?: AssistantMessage;
};

export type ToolCheckpoint =
  | { phase: "call" }
  /** 持久化的意图：最终参数与 replay 策略，记录在 execute() 之前。 */
  | { phase: "execute"; arguments: JsonValue; replay: ReplayPolicy };

export type TaskRecord =
  | {
      id: string;
      kind: "generation";
      conversationId: string;
      order: number;
      status: TaskStatus;
      /** 请求用的消息 = 会话里 index < inputEntryCount 的 entry。 */
      input: { inputEntryCount: number };
      checkpoint: GenerationCheckpoint;
      error?: string;
    }
  | {
      id: string;
      kind: "tool";
      conversationId: string;
      order: number;
      status: TaskStatus;
      input: { assistantEntryId: string; callId: string };
      checkpoint: ToolCheckpoint;
      error?: string;
    };

export interface DurableToolRegistration {
  tool: Tool;
  /** safe：中断后可以从头重跑；缺省 unsafe。 */
  replay?: ReplayPolicy;
}

export interface DurableHarnessOptions {
  store: DurableStore;
  model: Model;
  tools?: readonly DurableToolRegistration[];
  createId(): string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord<T>(value: JsonValue | undefined): T | undefined {
  return value === undefined ? undefined : (value as unknown as T);
}

function toJson<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function toolCallsOf(message: AssistantMessage): ToolCall[] {
  return message.content.filter(
    (block): block is ToolCall => block.type === "toolCall",
  );
}

/**
 * 一个最小 durable harness：prompt 提交用户 entry 与 generation 任务；run 按顺序
 * 取 pending 任务执行；每个任务的可见进展都先提交再发生。打开时把 running
 * 的任务改回 pending——上一个进程可能正跑到一半。
 */
export class DurableHarness {
  private readonly session: DurableSession;
  private readonly registry: ToolRegistry;
  private readonly replay = new Map<string, ReplayPolicy>();
  private nextOrder: number;

  private constructor(
    private readonly options: DurableHarnessOptions,
    session: DurableSession,
  ) {
    this.session = session;
    this.registry = new ToolRegistry();
    for (const registration of options.tools ?? []) {
      this.registry.register(registration.tool);
      this.replay.set(registration.tool.name, registration.replay ?? "unsafe");
    }
    this.nextOrder =
      Math.max(0, ...this.tasks().map((task) => task.order + 1));
  }

  /** 打开 = 读取已提交状态，并把 running 的任务改回 pending（一次提交）。 */
  static async open(options: DurableHarnessOptions): Promise<DurableHarness> {
    const session = new DurableSession(options.store);
    const harness = new DurableHarness(options, session);
    // Lab 19.2：一次提交里把所有 status 为 running 的任务改回 pending。
    throw labError("Lab 19.2 DurableHarness.open");
  }

  entries(conversationId: string): EntryRecord[] {
    return this.session
      .list("entries")
      .map(({ value }) => value as unknown as EntryRecord)
      .filter((record) => record.conversationId === conversationId)
      .sort((left, right) => left.index - right.index);
  }

  messages(conversationId: string): AgentMessage[] {
    return this.entries(conversationId).map((record) => record.entry.message);
  }

  tasks(): TaskRecord[] {
    return this.session
      .list("tasks")
      .map(({ value }) => value as unknown as TaskRecord)
      .sort((left, right) => left.order - right.order);
  }

  private task(id: string): TaskRecord {
    const task = asRecord<TaskRecord>(this.session.get("tasks", id));
    if (!task) throw new Error(`未知任务 ${id}`);
    return task;
  }

  private generationTask(id: string): Extract<TaskRecord, { kind: "generation" }> {
    const task = this.task(id);
    if (task.kind !== "generation") throw new Error(`任务 ${id} 不是 generation`);
    return task;
  }

  private toolTask(id: string): Extract<TaskRecord, { kind: "tool" }> {
    const task = this.task(id);
    if (task.kind !== "tool") throw new Error(`任务 ${id} 不是 tool`);
    return task;
  }

  private entry(id: string): EntryRecord {
    const record = asRecord<EntryRecord>(this.session.get("entries", id));
    if (!record) throw new Error(`未知 entry ${id}`);
    return record;
  }

  private putEntry(
    tx: Transaction,
    conversationId: string,
    entry: DurableEntry,
  ): EntryRecord {
    const index = tx
      .list("entries")
      .map(({ value }) => value as unknown as EntryRecord)
      .filter((record) => record.conversationId === conversationId).length;
    const record: EntryRecord = {
      id: this.options.createId(),
      conversationId,
      index,
      entry,
    };
    tx.put("entries", record.id, toJson(record));
    return record;
  }

  private putTask(tx: Transaction, task: TaskRecord): void {
    tx.put("tasks", task.id, toJson(task));
  }

  private newGeneration(
    tx: Transaction,
    conversationId: string,
    inputEntryCount: number,
  ): TaskRecord {
    const task: TaskRecord = {
      id: this.options.createId(),
      kind: "generation",
      conversationId,
      order: this.nextOrder++,
      status: "pending",
      input: { inputEntryCount },
      checkpoint: { phase: "request" },
    };
    this.putTask(tx, task);
    return task;
  }

  /** 用户消息与它触发的 generation 任务在同一次提交里出现：要么都可见，要么都不。 */
  prompt(conversationId: string, value: string): Promise<void> {
    return this.session.commit((tx) => {
      const record = this.putEntry(tx, conversationId, {
        type: "user",
        message: userMessage(value),
      });
      this.newGeneration(tx, conversationId, record.index + 1);
    });
  }

  /**
   * 按 order 取 pending 任务执行，直到没有 pending 任务或 signal 触发。
   * signal 触发时正在跑的任务停在 running：对存储来说这就像进程崩溃。
   */
  async run(_options: { signal?: AbortSignal } = {}): Promise<void> {
    // Lab 19.2：循环取 order 最小的 pending 任务；先提交 running，再在提交之外执行
    // runGeneration / runTool；它们返回 false（被 signal 打断）时停止。
    throw labError("Lab 19.2 DurableHarness.run");
  }

  /* ---------------------------------------------------------------- */
  /* Lab 19.4 · 生成：部分输出先提交；恢复时转 aborted 并从头重发         */
  /* ---------------------------------------------------------------- */

  private async runGeneration(
    taskId: string,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    let task = this.generationTask(taskId);
    const { conversationId } = task;

    // Lab 19.4：恢复——已提交的部分输出成为 aborted entry，检查点清空（同一次提交），
    // 再用 inputEntryCount 之前的同样消息从头重发请求。
    if (task.checkpoint.partial) {
      throw labError("Lab 19.4 partial output recovery");
    }

    const messages = this.entries(conversationId)
      .filter((record) => record.index < task.input.inputEntryCount)
      .map((record) => record.entry.message);
    const stream = this.options.model.stream(
      { messages, tools: this.registry.definitions() },
      { signal },
    );
    // signal 触发时立刻停止等待模型：对存储来说这就是“进程在这里崩溃”。
    const aborted = new Promise<"aborted">((resolve) => {
      if (signal?.aborted) resolve("aborted");
      signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    let message: AssistantMessage;
    try {
      const iterator = stream[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([iterator.next(), aborted]);
        if (next === "aborted") return false;
        if (next.done) break;
        const event = next.value;
        if (event.type === "text_delta") {
          // 节流在课程范围之外：每个增量都提交一次。
          await this.session.commit((tx) => {
            this.putTask(tx, {
              ...this.generationTask(taskId),
              checkpoint: { phase: "request", partial: event.partial },
            });
          });
        }
      }
      const result = await Promise.race([stream.result(), aborted]);
      if (result === "aborted") return false;
      message = result;
    } catch (error) {
      message = assistantMessage([], signal?.aborted ? "aborted" : "error", {
        errorMessage: errorMessage(error),
      });
    }
    if (signal?.aborted) return false;

    // 回复、它的工具任务与任务完成在同一次提交里出现。
    await this.session.commit((tx) => {
      const record = this.putEntry(tx, conversationId, {
        type: "assistant",
        message,
      });
      if (message.stopReason === "toolUse") {
        for (const call of toolCallsOf(message)) {
          this.putTask(tx, {
            id: this.options.createId(),
            kind: "tool",
            conversationId,
            order: this.nextOrder++,
            status: "pending",
            input: { assistantEntryId: record.id, callId: call.id },
            checkpoint: { phase: "call" },
          });
        }
      }
      this.putTask(tx, {
        ...this.generationTask(taskId),
        status: "completed",
        checkpoint: { phase: "request" },
      });
    });
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Lab 19.3 · 工具：execute() 之前提交意图；恢复按 replay 决定重跑或 interrupted */
  /* ---------------------------------------------------------------- */

  private readCall(task: Extract<TaskRecord, { kind: "tool" }>): ToolCall {
    const record = this.entry(task.input.assistantEntryId);
    const message = record.entry.message;
    const call =
      message.role === "assistant"
        ? toolCallsOf(message).find((candidate) => candidate.id === task.input.callId)
        : undefined;
    if (!call) throw new Error(`entry ${record.id} 没有 tool call ${task.input.callId}`);
    return call;
  }

  private async runTool(
    _taskId: string,
    _signal: AbortSignal | undefined,
  ): Promise<boolean> {
    // Lab 19.3：checkpoint 已是 execute → 存储 replay 与当前注册都 safe 才 execute()，否则
    // settle 一条 interrupted 错误结果并 failed；否则未知工具 / 参数非法先 settle；合法时先提交
    // { phase: "execute", arguments, replay } 的意图，再在提交之外 execute()。
    void this.readCall;
    void this.execute;
    void this.settle;
    void failedResult;
    throw labError("Lab 19.3 DurableHarness.runTool");
  }

  private async execute(
    task: Extract<TaskRecord, { kind: "tool" }>,
    call: ToolCall,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const result = await executeToolCall(call, this.registry, { signal });
    if (signal?.aborted) return false;
    await this.settle(task, result, "completed");
    return true;
  }

  /** 结果 entry 与任务终态同一次提交；本轮工具都有结果后，同一次提交里创建下一轮 generation。 */
  private settle(
    task: Extract<TaskRecord, { kind: "tool" }>,
    result: ToolResultMessage,
    status: "completed" | "failed",
    error?: string,
  ): Promise<void> {
    return this.session.commit((tx) => {
      const record = this.putEntry(tx, task.conversationId, {
        type: "toolResult",
        message: result,
      });
      this.putTask(tx, {
        ...this.toolTask(task.id),
        status,
        ...(error === undefined ? {} : { error }),
      });
      const assistant = this.entry(task.input.assistantEntryId).entry.message;
      const calls = assistant.role === "assistant" ? toolCallsOf(assistant) : [];
      const siblings = this.tasks().filter(
        (candidate) =>
          candidate.kind === "tool" &&
          candidate.input.assistantEntryId === task.input.assistantEntryId &&
          candidate.id !== task.id,
      );
      const allSettled = siblings.every(
        (sibling) => sibling.status === "completed" || sibling.status === "failed",
      );
      if (calls.length > 0 && allSettled) {
        this.newGeneration(tx, task.conversationId, record.index + 1);
      }
    });
  }
}

function failedResult(
  call: ToolCall,
  code: string,
  message: string,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: `Tool ${call.name} failed: ${message}` }],
    details: { error: code, message },
    isError: true,
    timestamp: Date.now(),
  };
}
