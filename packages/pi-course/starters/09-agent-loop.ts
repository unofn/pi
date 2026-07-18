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
  type UserMessage,
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
  takeSteeringMessages?(): UserMessage[];
  takeFollowUpMessages?(): UserMessage[];
  executeToolCall?: ToolExecutor;
  /**
   * 课程增强：防止错误脚本无限循环。它不是上游 Pi 核心的同名保证。
   */
  maxSteps?: number;
}

function labError(lab: string): Error {
  return new Error(`${lab} 尚未实现`);
}

function emit(
  options: AgentLoopOptions,
  event: LoopEvent,
): void {
  options.onEvent?.(event);
}

function toolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter(
    (block): block is ToolCall => block.type === "toolCall",
  );
}

function skippedCall(
  call: ToolCall,
  reason: "length" | "error" | "aborted" | "unexpected-stop",
): ToolResultMessage {
  const explanation =
    reason === "length"
      ? "the model response was truncated"
      : reason === "unexpected-stop"
        ? "the model returned stop with a tool call"
        : `the model turn ended with ${reason}`;
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [
      {
        type: "text",
        text: `Tool call was not executed because ${explanation}.`,
      },
    ],
    details: { skipped: true, reason },
    isError: true,
    timestamp: Date.now(),
  };
}

function failedExecution(
  call: ToolCall,
  error: unknown,
): ToolResultMessage {
  const message =
    error instanceof Error ? error.message : String(error);
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [
      {
        type: "text",
        text: `Tool ${call.name} failed: ${message}`,
      },
    ],
    details: { error: message },
    isError: true,
    timestamp: Date.now(),
  };
}

/**
 * Chapter 07–08 已完成的 loop 保留在这里。
 *
 * Chapter 09 只改跨运行接缝：模型异常保留 transcript、公开消息可复制、
 * 文本 stop 的取消，以及 steering/follow-up 的消费时机。
 */
export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentRunResult> {
  const messages = structuredClone(options.context.messages);
  const maxSteps = options.maxSteps ?? 32;
  const executeToolCall: ToolExecutor =
    options.executeToolCall ??
    ((call, context) =>
      executeCoreToolCall(call, options.tools, context));
  let ended = false;
  const finish = (
    reason: AgentRunResult["reason"],
    steps: number,
  ): AgentRunResult => {
    if (!ended) {
      ended = true;
      emit(options, { type: "turn_end", reason });
    }
    return { reason, messages, steps };
  };

  for (let steps = 1; steps <= maxSteps; steps += 1) {
    if (options.signal?.aborted) {
      return finish("aborted", steps - 1);
    }

    let assistant: AssistantMessage;
    try {
      // 请求只由 messages 与 tools 组成：system prompt 已经是 messages 里的
      // system message，loop 不单独传递，也从不写入新的 system message。
      const stream = options.model.stream(
        {
          messages,
          tools: options.tools.definitions(),
        },
        { signal: options.signal },
      );

      for await (const event of stream) {
        emit(options, { type: "model_event", event });
      }
      assistant = await stream.result();
    } catch {
      // Lab 9.2：在 loop 内归一化模型异常，不能丢掉 messages 中已经完成的事实。
      throw labError("Lab 9.2 model failure");
    }

    messages.push(assistant);
    emit(options, { type: "assistant_message", message: assistant });
    const calls = toolCalls(assistant);

    if (assistant.stopReason === "length") {
      for (const call of calls) {
        const result = skippedCall(call, "length");
        messages.push(result);
        emit(options, { type: "tool_skipped", result });
      }
      return finish("length", steps);
    }

    if (
      assistant.stopReason === "error" ||
      assistant.stopReason === "aborted"
    ) {
      const reason = assistant.stopReason;
      for (const call of calls) {
        const result = skippedCall(call, reason);
        messages.push(result);
        emit(options, { type: "tool_skipped", result });
      }
      return finish(reason, steps);
    }

    if (assistant.stopReason === "stop") {
      if (calls.length > 0) {
        for (const call of calls) {
          const result = skippedCall(call, "unexpected-stop");
          messages.push(result);
          emit(options, { type: "tool_skipped", result });
        }
        return finish("error", steps);
      }
      if (options.signal?.aborted) {
        // Lab 9.4：文本模型即使忽略 signal，loop 也要在边界结算 aborted。
        throw labError("Lab 9.4 text-stop abort");
      }
      const steering = options.takeSteeringMessages?.() ?? [];
      if (steering.length > 0) {
        // Lab 9.5：追加这一批消息并继续下一轮。
        throw labError("Lab 9.5 text-stop steering");
      }
      const followUps = options.takeFollowUpMessages?.() ?? [];
      if (followUps.length > 0) {
        // Lab 9.5：只在自然 stop 后追加 follow-up，再继续下一轮。
        throw labError("Lab 9.5 natural-stop follow-up");
      }
      return finish("stop", steps);
    }

    if (calls.length === 0) {
      return finish("error", steps);
    }

    calls.forEach((call) => emit(options, { type: "tool_start", call }));
    const results = await Promise.all(
      calls.map(async (call) => {
        let result: ToolResultMessage;
        try {
          result = await executeToolCall(call, {
            signal: options.signal,
            reportProgress: (content) => {
              emit(options, {
                type: "tool_progress",
                callId: call.id,
                content,
              });
            },
          });
        } catch (error) {
          result = failedExecution(call, error);
        }

        try {
          structuredClone(result);
        } catch {
          // Lab 9.3：把不可复制的自定义结果变成 canonical error result。
          throw labError("Lab 9.3 structured-cloneable tool result");
        }

        emit(options, { type: "tool_end", result });
        return result;
      }),
    );

    for (const result of results) {
      messages.push(result);
    }

    if (options.signal?.aborted) {
      return finish("aborted", steps);
    }
    const steering = options.takeSteeringMessages?.() ?? [];
    if (steering.length > 0) {
      // Lab 9.5：完整配对结果以后，按 FIFO 追加 steering。
      throw labError("Lab 9.5 tool-batch steering");
    }
  }

  return finish("maxSteps", maxSteps);
}
