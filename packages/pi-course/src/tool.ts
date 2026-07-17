import {
  text,
  type TextContent,
  type ToolCall,
  type ToolDefinition,
  type ToolResultMessage,
} from "./types.js";

export interface Schema<T> {
  parse(value: unknown): T;
  jsonSchema?: Record<string, unknown>;
}

export type Validator<T> = ((value: unknown) => T) & {
  jsonSchema?: Record<string, unknown>;
  optional?: boolean;
};

export const stringValue: Validator<string> = Object.assign(
  (value: unknown) => {
    if (typeof value !== "string") throw new Error("必须是 string");
    return value;
  },
  { jsonSchema: { type: "string" } },
);

export const optionalString: Validator<string | undefined> = Object.assign(
  (value: unknown) => {
    if (value === undefined) return undefined;
    return stringValue(value);
  },
  { jsonSchema: { type: "string" }, optional: true },
);

export const optionalPositiveInteger: Validator<number | undefined> =
  Object.assign(
    (value: unknown) => {
      if (value === undefined) return undefined;
      if (!Number.isInteger(value) || Number(value) < 1) {
        throw new Error("必须是正整数");
      }
      return Number(value);
    },
    {
      jsonSchema: { type: "integer", minimum: 1 },
      optional: true,
    },
  );

export function objectSchema<
  TShape extends Record<string, Validator<unknown>>,
>(shape: TShape): Schema<{
  [TKey in keyof TShape]: ReturnType<TShape[TKey]>;
}> {
  return {
    jsonSchema: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(shape).map(([key, validator]) => [
          key,
          validator.jsonSchema ?? {},
        ]),
      ),
      required: Object.entries(shape)
        .filter(([, validator]) => !validator.optional)
        .map(([key]) => key),
      additionalProperties: false,
    },
    parse(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("参数必须是 object");
      }
      const result = {} as {
        [TKey in keyof TShape]: ReturnType<TShape[TKey]>;
      };
      for (const [key, validator] of Object.entries(shape)) {
        result[key as keyof TShape] = validator(
          (value as Record<string, unknown>)[key],
        ) as ReturnType<TShape[keyof TShape]>;
      }
      return result;
    },
  };
}

export interface ToolContext {
  callId: string;
  signal?: AbortSignal;
  reportProgress?(content: TextContent[]): void;
}

export interface ToolOutput<TDetails = unknown> {
  content: TextContent[];
  details?: TDetails;
  isError?: boolean;
}

export type ToolExecutor = (
  call: ToolCall,
  context?: Omit<ToolContext, "callId">,
) => Promise<ToolResultMessage>;

export interface Tool<TParameters = unknown, TDetails = unknown> {
  name: string;
  description: string;
  schema: Schema<TParameters>;
  execute(
    parameters: TParameters,
    context: ToolContext,
  ): Promise<ToolOutput<TDetails>>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<unknown, unknown>>();

  constructor(tools: Tool<never, unknown>[] | Tool[] = []) {
    tools.forEach((tool) => this.register(tool));
  }

  register<TParameters, TDetails>(
    tool: Tool<TParameters, TDetails>,
  ): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool 已存在：${tool.name}`);
    }
    this.tools.set(tool.name, tool as Tool<unknown, unknown>);
  }

  get(name: string): Tool<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  list(): Tool<unknown, unknown>[] {
    return [...this.tools.values()];
  }

  definitions(): ToolDefinition[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.schema.jsonSchema ?? { type: "object" },
    }));
  }
}

function failedResult(
  call: ToolCall,
  error: unknown,
): ToolResultMessage {
  const message = error instanceof Error ? error.message : String(error);
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [text(`Tool ${call.name} failed: ${message}`)],
    details: { error: message },
    isError: true,
    timestamp: Date.now(),
  };
}

export async function executeToolCall(
  call: ToolCall,
  registry: ToolRegistry,
  context: Omit<ToolContext, "callId"> = {},
): Promise<ToolResultMessage> {
  const tool = registry.get(call.name);
  if (!tool) return failedResult(call, new Error("未知工具"));

  try {
    const parameters = tool.schema.parse(call.arguments);
    const output = await tool.execute(parameters, {
      ...context,
      callId: call.id,
    });
    return {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: output.content,
      details: output.details,
      isError: output.isError ?? false,
      timestamp: Date.now(),
    };
  } catch (error) {
    return failedResult(call, error);
  }
}
