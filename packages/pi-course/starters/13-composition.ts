import type {
  AgentEvent,
  AgentState,
} from "./agent.js";
import type { AgentRunResult } from "./agent-loop.js";
import type {
  ExtensionHost,
  ResourceCatalog,
} from "./resources.js";
import type {
  SessionEntry,
  SessionStore,
} from "./session.js";
import type { ToolRegistry } from "./tool.js";
import type {
  AgentMessage,
  Model,
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

export interface RuntimeDeps {
  model: Model;
  tools: ToolRegistry;
  session: SessionStore;
  resources: ResourceCatalog;
  extensionHost?: ExtensionHost;
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

/**
 * Lab 13.1 可以先用这个外壳返回 Runtime：恢复 active path、创建 Agent，
 * 再把 control/session/resources/extensions 接进来即可。这里故意不要求
 * 第一段就实现 prompt 的持久化状态机。
 */
class RuntimeImpl implements Runtime {
  constructor(
    readonly control: RuntimeControl,
    readonly session: SessionStore,
    readonly resources: ResourceCatalog,
    readonly extensions: ExtensionHost | undefined,
    private readonly activeLeafId: string | null,
  ) {}

  getActiveLeafId(): string | null {
    return this.activeLeafId;
  }

  prompt(_value: string): Promise<AgentRunResult> {
    return Promise.reject(
      labError("Lab 13.3 prompt persistence"),
    );
  }

  flush(): Promise<void> {
    return Promise.reject(
      labError("Lab 13.3 prompt persistence"),
    );
  }

  dispose(): Promise<void> {
    return Promise.reject(
      labError("Lab 13.3 prompt persistence"),
    );
  }
}

/**
 * 这是 Chapter 13 的学习脚手架，不是参考实现。
 *
 * 公共表面已经固定。composition root、临时 context 投影、session
 * 持久化状态机和 mode 呈现分别留给四段实验。
 */
export async function createRuntime(
  _config: RuntimeConfig,
  _deps: RuntimeDeps,
): Promise<Runtime> {
  // Lab 13.1：恢复显式 active path，并把所有依赖接成唯一 Runtime。
  throw labError("Lab 13.1 createRuntime");
}

export function createContextProjectingModel(
  _inner: Model,
  _config: Pick<RuntimeConfig, "context">,
  _getSnapshot: () => ContextProjectionSnapshot,
): Model {
  // Lab 13.2：把临时消息接到 active path，再调用 Chapter 11 buildContext。
  throw labError("Lab 13.2 context projection");
}

export async function runMode(
  _runtime: Runtime,
  _mode: RuntimeMode,
  _prompt: string,
  _io: ModeIO,
): Promise<AgentRunResult> {
  // Lab 13.4：三种 mode 都只调用一次 Runtime.prompt，再选择输出形式。
  throw labError("Lab 13.4 runMode");
}
