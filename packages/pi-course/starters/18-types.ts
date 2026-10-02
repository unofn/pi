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
  /** 从这一点开始对模型可见的工具的完整定义。 */
  toolsAdded?: ToolDefinition[];
  /** 从这一点开始不再对模型可见的工具。 */
  toolsRemoved?: ToolReference[];
  timestamp: number;
}

/** 按名字引用一个已声明的工具。 */
export interface ToolReference {
  name: string;
}

export type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentContext {
  messages: AgentMessage[];
  tools?: ToolDefinition[];
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

/**
 * 这是 Chapter 18 的学习脚手架：第 03 / 15 章的类型与函数原样保留，只增加
 * ThinkingLevel 与 Model.stream 的 options 类型，没有施工位。
 */

/** 推理强度。课程 provider 不解释它，只由第 18 章的路由决定并随请求传递。 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface ModelStreamOptions {
  signal?: AbortSignal;
  thinkingLevel?: ThinkingLevel;
}

export interface Model {
  stream(context: AgentContext, options?: ModelStreamOptions): ModelStream;
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

/**
 * 按顺序重放所有 system message 的 toolsRemoved / toolsAdded，得到此刻对模型
 * 可见的工具集合。先删后加，所以同一条消息里“删除再声明”等于重新定义。
 * 返回值按首次声明顺序排列，并与 transcript 不共享引用。
 */
export function currentTools(
  messages: readonly AgentMessage[],
): ToolDefinition[] {
  const tools = new Map<string, ToolDefinition>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) {
      tools.set(tool.name, toToolDeclaration(tool));
    }
  }
  return [...tools.values()];
}

/** 只保留模型看得到的三个字段，并做一次 JSON 往返，让比较与持久化看到同一形状。 */
export function toToolDeclaration(tool: ToolDefinition): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: JSON.parse(JSON.stringify(tool.parameters)) as Record<
      string,
      unknown
    >,
  };
}

/** 两个工具是否向模型声明了同一个接口。 */
export function declarationsEqual(
  left: ToolDefinition,
  right: ToolDefinition,
): boolean {
  return (
    JSON.stringify(toToolDeclaration(left)) ===
    JSON.stringify(toToolDeclaration(right))
  );
}

export interface ToolStateChanges {
  toolsAdded: ToolDefinition[];
  toolsRemoved: ToolReference[];
}

/**
 * 比较两个完整的工具集合。定义变化的工具同时出现在 toolsRemoved 与
 * toolsAdded 里：重放时先删后加，就得到新定义。
 */
export function toolStateChanges(
  previous: readonly ToolDefinition[],
  current: readonly ToolDefinition[],
): ToolStateChanges {
  const previousByName = new Map(previous.map((tool) => [tool.name, tool]));
  const currentByName = new Map(current.map((tool) => [tool.name, tool]));
  return {
    toolsAdded: current
      .filter((tool) => {
        const before = previousByName.get(tool.name);
        return before === undefined || !declarationsEqual(before, tool);
      })
      .map(toToolDeclaration),
    toolsRemoved: previous
      .filter((tool) => {
        const after = currentByName.get(tool.name);
        return after === undefined || !declarationsEqual(tool, after);
      })
      .map((tool) => ({ name: tool.name })),
  };
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
