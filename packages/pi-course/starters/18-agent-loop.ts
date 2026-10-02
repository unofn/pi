import {
  executeToolCall as executeCoreToolCall,
  type ToolExecutor,
  type ToolRegistry,
} from "./tool.js";
import {
  assistantMessage,
  currentTools,
  toolStateChanges,
  type AgentContext,
  type AgentMessage,
  type AssistantMessage,
  type Model,
  type ModelEvent,
  type SystemMessage,
  type TextContent,
  type ThinkingLevel,
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

/**
 * 这是 Chapter 18 的学习脚手架，不是参考实现：第 15 章的 loop 原样保留，
 * 只增加 prepareRequest 钩子的类型，并把请求原因与钩子调用留作 Lab 18.2。
 *
 * 为什么发出这次请求：
 * - user：最近一次回复之后有用户写的消息（prompt、steering、follow-up）；
 * - continuation：loop 内的其他请求，例如工具结果之后；
 * - retry：transcript 以失败回复结尾且其后没有用户消息——调用方直接重发。
 */
export type RequestReason = "user" | "continuation" | "retry";

export interface AgentRequest {
  context: AgentContext;
  /** 配置的模型；钩子可以换成本次真正要用的物理模型。 */
  model: Model;
  reason: RequestReason;
  /** retry 时：那条失败回复。 */
  failed?: AssistantMessage;
}

export interface PreparedRequest {
  model?: Model;
  thinkingLevel?: ThinkingLevel;
}

/**
 * 每次请求前的钩子：可以换掉本次的模型与推理强度，不能改写 transcript。
 * 抛错或 reject 以一条 error 回复结束本次请求。
 */
export type PrepareRequestHook = (
  request: AgentRequest,
  signal?: AbortSignal,
) =>
  | PreparedRequest
  | undefined
  | void
  | Promise<PreparedRequest | undefined | void>;

export interface AgentLoopOptions {
  model: Model;
  tools: ToolRegistry;
  context: AgentContext;
  signal?: AbortSignal;
  prepareRequest?: PrepareRequestHook;
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
    // 错误对象不能进入 transcript：它可能携带 stack、路径或凭据。
    details: { error: message },
    isError: true,
    timestamp: Date.now(),
  };
}

function canonicalToolResult(
  call: ToolCall,
  result: ToolResultMessage,
): ToolResultMessage {
  try {
    return structuredClone(result);
  } catch {
    return failedExecution(
      call,
      new Error("tool result is not structured-cloneable"),
    );
  }
}

function declaresTools(messages: readonly AgentMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "system" &&
      ((message.toolsAdded?.length ?? 0) > 0 ||
        (message.toolsRemoved?.length ?? 0) > 0),
  );
}

/**
 * 把本次请求的声明集合与 transcript 重放出的工具集合比较，只在有差异时
 * 生成一条只含 toolsAdded / toolsRemoved 的 system 补丁。全 direct 的注册表
 * （第 06–14 章的世界）不写补丁：那时 context.tools 就是全部事实；一旦
 * 注册表用上 exposure，或恢复出的 transcript 已经有声明，差异就必须落进
 * transcript。补丁只追加，从不改写已有前缀。
 */
function declareToolChanges(
  messages: readonly AgentMessage[],
  registry: ToolRegistry,
): SystemMessage | undefined {
  if (!registry.usesExposure() && !declaresTools(messages)) return undefined;
  const changes = toolStateChanges(
    currentTools(messages),
    registry.definitions(),
  );
  if (
    changes.toolsAdded.length === 0 &&
    changes.toolsRemoved.length === 0
  ) {
    return undefined;
  }
  return {
    role: "system",
    content: "",
    ...(changes.toolsAdded.length > 0
      ? { toolsAdded: changes.toolsAdded }
      : {}),
    ...(changes.toolsRemoved.length > 0
      ? { toolsRemoved: changes.toolsRemoved }
      : {}),
    timestamp: Date.now(),
  };
}

/** 从 transcript 尾部判断请求原因；retry 时附带那条失败回复。 */
export function requestReason(
  _messages: readonly AgentMessage[],
): { reason: RequestReason; failed?: AssistantMessage } {
  // Lab 18.2：最后一条 assistant 之后有 user → user；没有且它是 error / aborted → retry（带 failed）；否则 continuation。
  throw labError("Lab 18.2 requestReason");
}

function prepareRequestHole(): PreparedRequest | undefined {
  throw labError("Lab 18.2 prepareRequest hook");
}

function failedModelTurn(
  error: unknown,
  aborted: boolean,
): {
  reason: "error" | "aborted";
  message: AssistantMessage;
} {
  const reason = aborted ? "aborted" : "error";
  const errorMessage =
    error instanceof Error ? error.message : String(error);
  return {
    reason,
    message: assistantMessage([], reason, { errorMessage }),
  };
}

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
    // 请求前先让 transcript 说出本次声明的工具集合：有差异才追加一条声明补丁。
    // 它跟在本轮已有消息之后（用户消息或工具结果之后），紧贴即将发出的请求。
    const declaration = declareToolChanges(messages, options.tools);
    if (declaration) messages.push(declaration);
    let assistant: AssistantMessage;
    try {
      // 请求只由 messages 与 tools 组成：system prompt 已经是 messages 里的
      // system message，loop 不单独传递；除工具声明补丁外不写入 system message。
      const context: AgentContext = {
        messages,
        tools: options.tools.definitions(),
      };
      // Lab 18.2：有钩子时先 await 它（传 context、配置的模型、requestReason 的结果与 signal），
      // 用它换入的模型与 thinkingLevel 发请求；钩子抛错由外层 catch 变成 error 回复。
      const prepared: PreparedRequest | undefined = options.prepareRequest
        ? prepareRequestHole()
        : undefined;
      void requestReason;
      const model = prepared?.model ?? options.model;
      const stream = model.stream(context, {
        signal: options.signal,
        ...(prepared?.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: prepared.thinkingLevel }),
      });

      for await (const event of stream) {
        emit(options, { type: "model_event", event });
      }
      assistant = structuredClone(await stream.result());
    } catch (error) {
      const failed = failedModelTurn(
        error,
        options.signal?.aborted === true,
      );
      messages.push(failed.message);
      emit(options, {
        type: "assistant_message",
        message: failed.message,
      });
      return finish(failed.reason, steps);
    }
    messages.push(assistant);
    emit(options, { type: "assistant_message", message: assistant });
    const calls = toolCalls(assistant);

    if (assistant.stopReason === "length") {
      // length 可能截断 arguments，绝不执行；但已经形成的 call 仍要获得配对结果，
      // 避免把悬空 toolCall 写进 transcript。
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
        return finish("aborted", steps);
      }
      const steering = options.takeSteeringMessages?.() ?? [];
      if (steering.length > 0) {
        messages.push(...steering);
        continue;
      }
      const followUps = options.takeFollowUpMessages?.() ?? [];
      if (followUps.length > 0) {
        messages.push(...followUps);
        continue;
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
          result = canonicalToolResult(
            call,
            await executeToolCall(call, {
              signal: options.signal,
              reportProgress: (content) => {
                emit(options, {
                  type: "tool_progress",
                  callId: call.id,
                  content,
                });
              },
            }),
          );
        } catch (error) {
          // 注入的执行器不一定像 core executor 一样自行归一化异常。
          // 每个 call 都必须形成结果，且一个拒绝不能让同批兄弟结果丢失。
          result = failedExecution(call, error);
        }
        // 观察事件反映真实完成顺序；Promise.all 返回值仍保持 call 顺序。
        emit(options, { type: "tool_end", result });
        return result;
      }),
    );

    // Promise 完成顺序可以不同，但 transcript 必须按原始 call 顺序配对追加。
    for (const result of results) {
      messages.push(result);
    }

    if (options.signal?.aborted) {
      return finish("aborted", steps);
    }
    const steering = options.takeSteeringMessages?.() ?? [];
    messages.push(...steering);
  }

  return finish("maxSteps", maxSteps);
}
