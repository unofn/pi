export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
  rawArguments?: string;
}

export type AssistantContent = TextContent | ToolCall;

export interface Usage {
  input: number;
  output: number;
  totalTokens: number;
}

export type StopReason =
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted";

export interface UserMessage {
  role: "user";
  content: TextContent[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage<TDetails = unknown> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: TextContent[];
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}

/**
 * system prompt 是 transcript 的一部分。开头一条 system message 是基础 prompt；
 * 之后的 system message 只做增量：content 追加说明，sections 按名字替换段落，
 * null 删除段落。按顺序重放全部 system message，就得到当前 prompt。
 */
export interface SystemMessage {
  role: "system";
  /** 开头一条：基础 prompt；之后：追加的说明。可以为空字符串。 */
  content: string;
  /** 具名段落。之后的 system message 按名字替换，null 表示删除。 */
  sections?: Record<string, string | null>;
  timestamp: number;
}

export type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

export interface AgentContext {
  messages: AgentMessage[];
}

export type ModelEvent =
  | { type: "start"; partial: AssistantMessage }
  | {
      type: "text_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: ToolCall;
      partial: AssistantMessage;
    }
  | {
      type: "done";
      reason: Extract<StopReason, "stop" | "length" | "toolUse">;
      message: AssistantMessage;
    }
  | {
      type: "error";
      reason: Extract<StopReason, "error" | "aborted">;
      error: AssistantMessage;
    };

export interface ModelStream extends AsyncIterable<ModelEvent> {
  result(): Promise<AssistantMessage>;
}

export interface Model {
  stream(
    context: AgentContext,
    options?: { signal?: AbortSignal },
  ): ModelStream;
}

export const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  totalTokens: 0,
};

export function text(value: string): TextContent {
  return { type: "text", text: value };
}

export function userMessage(value: string): UserMessage {
  return {
    role: "user",
    content: [text(value)],
    timestamp: Date.now(),
  };
}

export function textOf(message: AgentMessage): string {
  if (message.role === "system") return systemMessageText(message);
  const blocks: readonly AssistantContent[] = message.content;
  return blocks.flatMap((block) =>
    block.type === "text" ? [block.text] : []
  ).join("\n");
}

/**
 * 按顺序重放所有 system message：非空 content 依次追加，sections 按名字覆盖，
 * null 删除。没有任何 system message 时返回 undefined；时间戳取第一条。
 */
export function currentSystemMessage(
  messages: readonly AgentMessage[],
): SystemMessage | undefined {
  const content: string[] = [];
  const sections = new Map<string, string>();
  let timestamp: number | undefined;
  for (const message of messages) {
    if (message.role !== "system") continue;
    timestamp ??= message.timestamp;
    if (message.content.length > 0) content.push(message.content);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  if (timestamp === undefined) return undefined;
  return {
    role: "system",
    content: content.join("\n\n"),
    ...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
    timestamp,
  };
}

/** 把一条 system message 渲染成完整 prompt：content 后接各段落正文，空串跳过。 */
export function systemMessageText(message: SystemMessage): string {
  const parts = [message.content];
  for (const value of Object.values(message.sections ?? {})) {
    if (value !== null) parts.push(value);
  }
  return parts.filter((part) => part.length > 0).join("\n\n");
}

export function currentSystemPrompt(
  messages: readonly AgentMessage[],
): string | undefined {
  const message = currentSystemMessage(messages);
  return message ? systemMessageText(message) : undefined;
}

export function assistantMessage(
  content: AssistantContent[],
  stopReason: StopReason = "stop",
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    provider: "scripted",
    model: "scripted-v1",
    usage: EMPTY_USAGE,
    stopReason,
    timestamp: Date.now(),
    ...overrides,
  };
}
