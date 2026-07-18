import {
  runAgentLoop,
  type AgentRunResult,
  type LoopEvent,
} from "./agent-loop.js";
import type { ToolExecutor, ToolRegistry } from "./tool.js";
import type {
  AgentMessage,
  Model,
  SystemMessage,
  UserMessage,
} from "./types.js";

export interface AgentOptions {
  model: Model;
  tools: ToolRegistry;
  toolExecutor?: ToolExecutor;
  /** 非空时成为 transcript 开头的 system message（基础 prompt）。 */
  systemPrompt?: string;
  maxSteps?: number;
}

/**
 * 改 prompt 只能追加 system message。给出 system 时，Agent 在本次运行开始、
 * 用户消息之前把补丁追加进 transcript；运行中途不能插入 system message。
 */
export interface PromptOptions {
  system?: {
    content?: string;
    sections?: Record<string, string | null>;
  };
}

export interface AgentState {
  status: "idle" | "running";
  messages: AgentMessage[];
  activeRunId?: number;
  lastReason?: AgentRunResult["reason"];
  streamingText: string;
  pendingToolCallIds: string[];
  diagnostics: string[];
}

export type AgentEvent =
  | {
      type: "run_start";
      runId: number;
      message: UserMessage;
      /** 本次运行随用户消息一起追加的 system 补丁，位于用户消息之前。 */
      system?: SystemMessage;
    }
  | { type: "loop"; runId: number; event: LoopEvent }
  | { type: "run_end"; runId: number; result: AgentRunResult };

function labError(lab: string): Error {
  return new Error(`${lab} 尚未实现`);
}

/**
 * 这是 Chapter 09 的学习脚手架，不是参考实现。
 *
 * 它只固定 state、event、options 与 Agent 的公共表面。reducer 分支、
 * 生命周期清理、订阅者隔离、取消传播和两种消息队列都留给聚焦测试驱动完成。
 */
export function reduceAgentState(
  _state: AgentState,
  _event: AgentEvent,
): AgentState {
  // Lab 9.1：根据事件派生新的状态快照。
  throw labError("Lab 9.1 reducer");
}

export class Agent {
  constructor(_options: AgentOptions) {}

  getState(): AgentState {
    // Lab 9.2：先发布生命周期状态；Lab 9.3 再验证防御性副本。
    throw labError("Lab 9.2 lifecycle");
  }

  get systemPrompt(): string | undefined {
    // Lab 9.2：只读地重放 transcript 里的 system message。
    throw labError("Lab 9.2 lifecycle");
  }

  subscribe(_listener: (event: AgentEvent) => void): () => void {
    // Lab 9.2：先接通 start/end；Lab 9.3 再隔离失败与可变引用。
    throw labError("Lab 9.2 lifecycle");
  }

  steer(_value: string): void {
    // Lab 9.5：把 steering 接到它自己的队列施工位。
    throw labError("Lab 9.5 queues");
  }

  followUp(_value: string): void {
    // Lab 9.5：把 follow-up 接到它自己的队列施工位。
    throw labError("Lab 9.5 queues");
  }

  abort(): void {
    // Lab 9.4：把取消意图交给当前运行。
    throw labError("Lab 9.4 abort");
  }

  async prompt(
    _value: string,
    _options: PromptOptions = {},
  ): Promise<AgentRunResult> {
    // Lab 9.2：复用既有 loop，管理一次运行的开始、结束和失败；
    // system 补丁与用户消息一起成为本次运行的新增部分。
    throw labError("Lab 9.2 lifecycle");
  }
}
