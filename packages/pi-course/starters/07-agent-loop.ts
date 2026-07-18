import {
  executeToolCall as executeCoreToolCall,
  type ToolExecutor,
  type ToolRegistry,
} from "./tool.js";
import {
  type AgentContext,
  type AgentMessage,
  type AssistantMessage,
  type Model,
  type ModelEvent,
  type TextContent,
  type ToolCall,
  type ToolResultMessage,
} from "./types.js";

export type LoopEvent =
  | { type: "model_event"; event: ModelEvent }
  | { type: "assistant_message"; message: AssistantMessage }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_progress"; callId: string; content: TextContent[] }
  | { type: "tool_end"; result: ToolResultMessage }
  | { type: "tool_skipped"; result: ToolResultMessage }
  | { type: "turn_end"; reason: AgentRunResult["reason"] };

export interface AgentRunResult {
  reason:
    | "stop"
    | "length"
    | "error"
    | "aborted"
    | "maxSteps";
  messages: AgentMessage[];
  steps: number;
}

export interface AgentLoopOptions {
  model: Model;
  tools: ToolRegistry;
  context: AgentContext;
  signal?: AbortSignal;
  onEvent?(event: LoopEvent): void;
  executeToolCall?: ToolExecutor;
  maxSteps?: number;
}

function labError(lab: string): Error {
  return new Error(`${lab} 尚未实现`);
}

function toolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter(
    (block): block is ToolCall => block.type === "toolCall",
  );
}

async function collectModelTurn(
  _options: AgentLoopOptions,
  _messages: AgentMessage[],
): Promise<AssistantMessage> {
  // Lab 7.1：创建请求、消费事件流、取得最终 assistant message。
  throw labError("Lab 7.1 收集模型终态");
}

/**
 * 这是控制流脚手架，不是参考实现。
 *
 * 五个 Lab 依次闭合一条最小路径，再增加终态协议、并发与控制器约束。
 * 每个占位都必须由本章聚焦测试驱动完成。
 */
export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentRunResult> {
  const messages = structuredClone(options.context.messages);
  const maxSteps = options.maxSteps ?? 32;
  const executeToolCall: ToolExecutor =
    options.executeToolCall ??
    ((currentCall, context) =>
      executeCoreToolCall(currentCall, options.tools, context));

  for (let steps = 1; steps <= maxSteps; steps += 1) {
    if (options.signal?.aborted) {
      // Lab 7.5：预取消、工具后的取消、maxSteps 与唯一 turn_end。
      throw labError("Lab 7.5 cancellation and limits");
    }

    const assistant = await collectModelTurn(options, messages);
    messages.push(assistant);
    options.onEvent?.({ type: "assistant_message", message: assistant });
    const calls = toolCalls(assistant);

    if (assistant.stopReason === "stop" && calls.length === 0) {
      // Lab 7.1：无工具 stop 只发出一个 turn_end，并返回隔离的 transcript。
      throw labError("Lab 7.1 纯文本 stop");
    }

    if (
      assistant.stopReason === "length" ||
      assistant.stopReason === "error" ||
      assistant.stopReason === "aborted" ||
      (assistant.stopReason === "stop" && calls.length > 0) ||
      calls.length === 0
    ) {
      // Lab 7.3：非执行终态判定、逐 call 配对，以及非法 stop/toolUse。
      throw labError("Lab 7.3 non-executing terminals");
    }

    if (calls.length === 1) {
      // Lab 7.2：单工具闭环、signal/progress 与下一次模型请求。
      void executeToolCall;
      throw labError("Lab 7.2 one-tool roundtrip");
    }

    // Lab 7.4：同批并发；完成事件按真实时间，transcript 按 call 顺序；
    // 注入执行器的 rejection 要归一化，且不得吞掉兄弟结果。
    throw labError("Lab 7.4 concurrent tool batch");
  }

  // Lab 7.5：循环耗尽时保留最后一批结果，并以 maxSteps 唯一结束。
  throw labError("Lab 7.5 cancellation and limits");
}
