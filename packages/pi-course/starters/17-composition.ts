import {
  Agent,
  type AgentEvent,
  type AgentState,
  type PromptOptions,
} from "./agent.js";
import type { AgentRunResult } from "./agent-loop.js";
import { buildContext } from "./context.js";
import {
  formatResourceContext,
  RESOURCE_SECTION,
  type ExtensionHost,
  type ResourceCatalog,
} from "./resources.js";
import {
  pathTo,
  type MessageSessionEntry,
  type SessionEntry,
  type SessionStore,
} from "./session.js";
import {
  executeToolCall,
  type ToolExecutor,
  type ToolRegistry,
} from "./tool.js";
import {
  currentSystemMessage,
  textOf,
  type AgentContext,
  type AgentMessage,
  type Model,
} from "./types.js";

export interface ContextBudget {
  total: number;
  reservedOutput: number;
  safetyMargin: number;
  estimateTokens(value: string | AgentMessage): number;
}

export interface RuntimeConfig {
  activeLeafId: string | null;
  systemPrompt?: string;
  maxSteps?: number;
  context: ContextBudget;
}

/**
 * 这是 Chapter 17 的学习脚手架：第 13 章的 Runtime 原样保留，只增加
 * SystemSectionProvider 类型，并把段落合并留作 Lab 17.5。
 *
 * 额外的 system 段落来源（第 17 章的 MCP 服务器清单）。每次 prompt 前调用一次，
 * 返回的段落并入期望 system 状态，仍只在变化时打补丁。
 */
export interface SystemSectionProvider {
  sections(): Promise<Record<string, string>> | Record<string, string>;
}

export interface RuntimeDeps {
  model: Model;
  tools: ToolRegistry;
  session: SessionStore;
  resources: ResourceCatalog;
  extensionHost?: ExtensionHost;
  sectionProviders?: readonly SystemSectionProvider[];
  createId(): string;
  now(): number;
}

export interface RuntimeControl {
  getState(): AgentState;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  steer(value: string): void;
  followUp(value: string): void;
  abort(): void;
}

export interface Runtime {
  readonly control: RuntimeControl;
  readonly session: SessionStore;
  readonly resources: ResourceCatalog;
  readonly extensions: ExtensionHost | undefined;
  getActiveLeafId(): string | null;
  prompt(value: string): Promise<AgentRunResult>;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ContextProjectionSnapshot {
  activePath: readonly SessionEntry[];
  persistedMessageCount: number;
}

export type RuntimeMode = "interactive" | "print" | "json";

export interface ModeIO {
  write(value: string): void | Promise<void>;
}

function labError(lab: string): Error {
  return new Error(`${lab} 尚未实现`);
}

interface SystemState {
  content: string;
  sections: Record<string, string>;
}

/**
 * 期望的 system 状态：基础 prompt 来自配置，资源文本是 pi-resources 段落；
 * 资源为空则不含该段。
 */
function desiredSystemState(
  configured: string | undefined,
  resources: ResourceCatalog,
): SystemState {
  const sections: Record<string, string> = {};
  if (resources.resources.length > 0) {
    sections[RESOURCE_SECTION] = formatResourceContext(resources, []);
  }
  return { content: configured ?? "", sections };
}

/**
 * 用恢复出的 transcript 重放当前 system 状态，只为变化生成补丁：
 * - 还没有任何 system message、且期望状态非空：放一条开头 system message；
 * - 已有：比较段落，只为变化的段落打补丁（删除的段落为 null）；无变化则不追加。
 * 基础 prompt 只在第一次写入。恢复会话后若配置与重放出的基础 prompt 不同，
 * 以 transcript 为准、忽略配置差异：transcript 是事实，已持久化前缀永不改写。
 */
function systemPatch(
  messages: readonly AgentMessage[],
  desired: SystemState,
): PromptOptions["system"] {
  const current = currentSystemMessage(messages);
  const desiredNames = Object.keys(desired.sections);
  if (!current) {
    if (desired.content.length === 0 && desiredNames.length === 0) {
      return undefined;
    }
    return {
      content: desired.content,
      ...(desiredNames.length > 0
        ? { sections: { ...desired.sections } }
        : {}),
    };
  }

  const currentSections = current.sections ?? {};
  const sections: Record<string, string | null> = {};
  for (const name of desiredNames) {
    if (currentSections[name] !== desired.sections[name]) {
      sections[name] = desired.sections[name]!;
    }
  }
  for (const name of Object.keys(currentSections)) {
    if (!(name in desired.sections)) sections[name] = null;
  }
  return Object.keys(sections).length === 0 ? undefined : { sections };
}

function messagesIn(
  entries: readonly SessionEntry[],
): AgentMessage[] {
  return entries.flatMap((entry) =>
    entry.type === "message"
      ? [structuredClone(entry.message)]
      : []
  );
}

function temporaryEntries(
  snapshot: ContextProjectionSnapshot,
  messages: readonly AgentMessage[],
): SessionEntry[] {
  if (
    !Number.isInteger(snapshot.persistedMessageCount) ||
    snapshot.persistedMessageCount < 0 ||
    snapshot.persistedMessageCount > messages.length
  ) {
    throw new Error("persistedMessageCount 超出了当前 model context");
  }

  const activePath = structuredClone(snapshot.activePath);
  const occupiedIds = new Set(activePath.map((entry) => entry.id));
  let parentId = activePath.at(-1)?.id ?? null;
  const suffix = messages.slice(snapshot.persistedMessageCount);
  const entries: MessageSessionEntry[] = suffix.map((message, index) => {
    let id = `__runtime_context_${index}`;
    while (occupiedIds.has(id)) id = `_${id}`;
    occupiedIds.add(id);
    const entry: MessageSessionEntry = {
      id,
      parentId,
      timestamp: message.timestamp,
      type: "message",
      message: structuredClone(message),
    };
    parentId = id;
    return entry;
  });
  return [...activePath, ...entries];
}

/**
 * Agent 保留完整 canonical transcript；这个 adapter 只在每次模型请求前，
 * 把尚未持久化的临时 suffix 接到当前 active path，再调用唯一 buildContext。
 */
export function createContextProjectingModel(
  inner: Model,
  config: Pick<RuntimeConfig, "context">,
  getSnapshot: () => ContextProjectionSnapshot,
): Model {
  return {
    stream(context, options = {}) {
      const snapshot = getSnapshot();
      const projected = buildContext(
        temporaryEntries(snapshot, context.messages),
        {
          maxTokens: config.context.total,
          reservedOutput: config.context.reservedOutput,
          safetyMargin: config.context.safetyMargin,
          estimateTokens: config.context.estimateTokens,
        },
      );
      const request: AgentContext = {
        messages: structuredClone(projected.messages),
        tools:
          context.tools === undefined
            ? undefined
            : structuredClone(context.tools),
      };
      return inner.stream(request, { signal: options.signal });
    },
  };
}

class RuntimeImpl implements Runtime {
  readonly control: RuntimeControl;
  readonly session: SessionStore;
  readonly resources: ResourceCatalog;
  readonly extensions: ExtensionHost | undefined;

  private activePath: SessionEntry[];
  private persistedMessageCount: number;
  private activeLeafId: string | null;
  private operationTail: Promise<void> = Promise.resolve();
  private poisoned = false;
  private poisonCause: unknown;
  private disposed = false;
  private disposePromise?: Promise<void>;

  constructor(
    private readonly agent: Agent,
    initialPath: readonly SessionEntry[],
    private readonly deps: RuntimeDeps,
    private readonly desiredSystem: SystemState,
  ) {
    this.activePath = [...structuredClone(initialPath)];
    this.persistedMessageCount = messagesIn(initialPath).length;
    this.activeLeafId = initialPath.at(-1)?.id ?? null;
    this.session = deps.session;
    this.resources = deps.resources;
    this.extensions = deps.extensionHost;
    this.control = {
      getState: () => this.agent.getState(),
      subscribe: (listener) => this.agent.subscribe(listener),
      steer: (value) => this.agent.steer(value),
      followUp: (value) => this.agent.followUp(value),
      abort: () => this.agent.abort(),
    };
  }

  getActiveLeafId(): string | null {
    return this.activeLeafId;
  }

  private assertHealthy(): void {
    if (this.poisoned) throw this.poisonCause;
  }

  private async persist(
    messages: readonly AgentMessage[],
  ): Promise<void> {
    let parentId = this.activeLeafId;
    for (const message of messages) {
      try {
        const entry: MessageSessionEntry = {
          id: this.deps.createId(),
          parentId,
          timestamp: this.deps.now(),
          type: "message",
          message: structuredClone(message),
        };
        await this.session.append(entry);
        this.activePath.push(structuredClone(entry));
        this.persistedMessageCount += 1;
        this.activeLeafId = entry.id;
        parentId = entry.id;
      } catch (error) {
        this.poisoned = true;
        this.poisonCause = error;
        throw error;
      }
    }
  }

  prompt(value: string): Promise<AgentRunResult> {
    if (this.disposed) {
      return Promise.reject(new Error("Runtime 已 dispose"));
    }
    if (this.poisoned) {
      return Promise.reject(this.poisonCause);
    }

    const operation = this.operationTail.then(async () => {
      // 是否接受 prompt 只在调用时决定。dispose 可以关闭后续入口，
      // 但不能取消此前已经排入队列的工作。
      this.assertHealthy();
      const before = this.agent.getState().messages;
      // 每次 prompt 前重放当前 system 状态；补丁与用户消息一起成为本轮新 suffix。
      const system = systemPatch(before, await this.desiredSystemState());
      const result = await this.agent.prompt(
        value,
        system ? { system } : {},
      );
      const suffix = result.messages.slice(before.length);
      await this.persist(suffix);
      return structuredClone(result);
    });
    this.operationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async flush(): Promise<void> {
    await this.operationTail;
    if (this.poisoned) throw this.poisonCause;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = this.flush();
    return this.disposePromise;
  }

  /** 期望状态 = 配置与资源的基础状态 + 各段落提供者本次给出的段落。 */
  private async desiredSystemState(): Promise<SystemState> {
    // Lab 17.5：没有提供者时与第 13 章相同；有提供者时把它们的段落并入 sections。
    if ((this.deps.sectionProviders ?? []).length === 0) return this.desiredSystem;
    throw labError("Lab 17.5 sectionProviders");
  }

  contextSnapshot(): ContextProjectionSnapshot {
    return {
      activePath: structuredClone(this.activePath),
      persistedMessageCount: this.persistedMessageCount,
    };
  }
}

function validateSessionSelection(
  entries: readonly SessionEntry[],
  activeLeafId: string | null,
): SessionEntry[] {
  if (entries.length === 0) {
    if (activeLeafId !== null) {
      throw new Error(
        "空 session 的 activeLeafId 必须是 null",
      );
    }
    return [];
  }
  if (activeLeafId === null) {
    throw new Error(
      "非空 session 必须显式提供 activeLeafId",
    );
  }
  return pathTo(entries, activeLeafId);
}

/**
 * composition root 只在这里把 session、context、resources、extensions、
 * tools 和有状态 Agent 接成一个对象图。
 */
export async function createRuntime(
  config: RuntimeConfig,
  deps: RuntimeDeps,
): Promise<Runtime> {
  const entries = await deps.session.entries();
  const initialPath = validateSessionSelection(
    entries,
    config.activeLeafId,
  );
  const initialMessages = messagesIn(initialPath);
  const desiredSystem = desiredSystemState(
    config.systemPrompt,
    deps.resources,
  );

  let runtime!: RuntimeImpl;
  const model = createContextProjectingModel(
    deps.model,
    { context: config.context },
    () => runtime.contextSnapshot(),
  );
  const coreExecutor: ToolExecutor = (call, context) =>
    executeToolCall(call, deps.tools, context);
  const toolExecutor = deps.extensionHost
    ? deps.extensionHost.wrapExecutor(coreExecutor)
    : coreExecutor;
  // system prompt 不在构造时塞进 Agent：它必须和本轮 suffix 一起持久化，
  // 所以由 Runtime 在每次 prompt 前以 system 补丁追加。
  const agent = new Agent({
    model,
    tools: deps.tools,
    toolExecutor,
    initialMessages,
    maxSteps: config.maxSteps,
  });
  runtime = new RuntimeImpl(agent, initialPath, deps, desiredSystem);
  return runtime;
}

function finalAssistantText(result: AgentRunResult): string {
  const assistant = [...result.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  return assistant ? textOf(assistant) : "";
}

/**
 * mode 不拥有 Agent 或 persistence，只负责调用 Runtime.prompt 并选择输出编码。
 */
export async function runMode(
  runtime: Runtime,
  mode: RuntimeMode,
  prompt: string,
  io: ModeIO,
): Promise<AgentRunResult> {
  if (
    mode !== "interactive" &&
    mode !== "print" &&
    mode !== "json"
  ) {
    throw new Error(`未知 runtime mode：${String(mode)}`);
  }
  const result = await runtime.prompt(prompt);
  const output =
    mode === "json"
      ? `${JSON.stringify({
          reason: result.reason,
          steps: result.steps,
          messages: result.messages,
        })}\n`
      : finalAssistantText(result);
  await io.write(output);
  return structuredClone(result);
}
