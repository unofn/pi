import {
  runAgentLoop,
  type AgentRunResult,
  type LoopEvent,
} from "./agent-loop.js";
import type { ToolExecutor, ToolRegistry } from "./tool.js";
import {
  assistantMessage,
  currentSystemPrompt,
  userMessage,
  type AgentMessage,
  type Model,
  type SystemMessage,
  type UserMessage,
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

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function reduceAgentState(
  state: AgentState,
  event: AgentEvent,
): AgentState {
  if (event.type === "run_start") {
    return {
      ...state,
      status: "running",
      activeRunId: event.runId,
      lastReason: undefined,
      messages: [
        ...clone(state.messages),
        ...(event.system ? [clone(event.system)] : []),
        clone(event.message),
      ],
      streamingText: "",
      pendingToolCallIds: [],
    };
  }

  if (
    state.status !== "running" ||
    state.activeRunId !== event.runId
  ) {
    return state;
  }

  if (event.type === "loop") {
    const loop = event.event;
    if (
      loop.type === "model_event" &&
      loop.event.type === "text_delta"
    ) {
      return {
        ...state,
        streamingText: state.streamingText + loop.event.delta,
      };
    }
    if (loop.type === "tool_start") {
      return {
        ...state,
        pendingToolCallIds: [
          ...state.pendingToolCallIds,
          loop.call.id,
        ],
      };
    }
    if (loop.type === "tool_end" || loop.type === "tool_skipped") {
      return {
        ...state,
        pendingToolCallIds: state.pendingToolCallIds.filter(
          (id) => id !== loop.result.toolCallId,
        ),
      };
    }
    if (loop.type === "assistant_message") {
      return { ...state, streamingText: "" };
    }
    return state;
  }

  return {
    status: "idle",
    messages: clone(event.result.messages),
    lastReason: event.result.reason,
    streamingText: "",
    pendingToolCallIds: [],
    diagnostics: [...state.diagnostics],
  };
}

interface ActiveRun {
  id: number;
  controller: AbortController;
  steering: UserMessage[];
  followUps: UserMessage[];
  acceptingInput: boolean;
}

export class Agent {
  private state: AgentState;
  private readonly subscribers = new Set<(event: AgentEvent) => void>();
  private readonly pendingEvents: AgentEvent[] = [];
  private dispatchingEvents = false;
  private activeRun?: ActiveRun;
  private nextRunId = 1;

  constructor(private readonly options: AgentOptions) {
    // systemPrompt 不是请求上的字段，而是 transcript 开头的 system message。
    const messages: AgentMessage[] = options.systemPrompt
      ? [{ role: "system", content: options.systemPrompt, timestamp: 0 }]
      : [];
    this.state = {
      status: "idle",
      messages,
      streamingText: "",
      pendingToolCallIds: [],
      diagnostics: [],
    };
  }

  getState(): AgentState {
    return clone(this.state);
  }

  /** 只读：按顺序重放 transcript 里全部 system message 的结果。 */
  get systemPrompt(): string | undefined {
    return currentSystemPrompt(this.state.messages);
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  private emit(event: AgentEvent): void {
    this.pendingEvents.push(event);
    if (this.dispatchingEvents) return;

    this.dispatchingEvents = true;
    try {
      while (this.pendingEvents.length > 0) {
        const next = this.pendingEvents.shift()!;
        this.state = reduceAgentState(this.state, next);
        for (const listener of [...this.subscribers]) {
          try {
            listener(clone(next));
          } catch (error) {
            this.state = {
              ...this.state,
              diagnostics: [
                ...this.state.diagnostics,
                `subscriber: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ],
            };
          }
        }
      }
    } finally {
      this.dispatchingEvents = false;
    }
  }

  steer(value: string): void {
    if (!this.activeRun?.acceptingInput) {
      throw new Error("steering 只在当前 run 尚未结束时有意义");
    }
    this.activeRun.steering.push(userMessage(value));
  }

  followUp(value: string): void {
    if (!this.activeRun?.acceptingInput) {
      throw new Error("follow-up 只在当前 run 尚未结束时排队");
    }
    this.activeRun.followUps.push(userMessage(value));
  }

  abort(): void {
    this.activeRun?.controller.abort();
  }

  async prompt(
    value: string,
    options: PromptOptions = {},
  ): Promise<AgentRunResult> {
    if (this.activeRun) {
      throw new Error("Agent is busy");
    }

    const system: SystemMessage | undefined = options.system
      ? {
          role: "system",
          content: options.system.content ?? "",
          ...(options.system.sections
            ? { sections: clone(options.system.sections) }
            : {}),
          timestamp: Date.now(),
        }
      : undefined;
    const message = userMessage(value);
    const contextMessages = [
      ...clone(this.state.messages),
      ...(system ? [clone(system)] : []),
      clone(message),
    ];
    const run: ActiveRun = {
      id: this.nextRunId++,
      controller: new AbortController(),
      steering: [],
      followUps: [],
      acceptingInput: true,
    };
    this.activeRun = run;
    this.emit({
      type: "run_start",
      runId: run.id,
      message,
      ...(system ? { system } : {}),
    });

    let result: AgentRunResult;
    try {
      result = await runAgentLoop({
        model: this.options.model,
        tools: this.options.tools,
        context: { messages: contextMessages },
        signal: run.controller.signal,
        maxSteps: this.options.maxSteps,
        executeToolCall: this.options.toolExecutor,
        takeSteeringMessages: () => run.steering.splice(0),
        takeFollowUpMessages: () => run.followUps.splice(0),
        onEvent: (event) => {
          if (event.type === "turn_end") run.acceptingInput = false;
          this.emit({ type: "loop", runId: run.id, event });
        },
      });
    } catch (error) {
      const failed = assistantMessage([], "error", {
        errorMessage:
          error instanceof Error ? error.message : String(error),
      });
      result = {
        reason: "error",
        messages: [...contextMessages, failed],
        steps: 0,
      };
    } finally {
      if (this.activeRun === run) this.activeRun = undefined;
      run.steering.splice(0);
      run.followUps.splice(0);
    }

    this.emit({ type: "run_end", runId: run.id, result });
    return clone(result);
  }
}
