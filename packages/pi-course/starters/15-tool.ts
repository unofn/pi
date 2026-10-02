import {
  text,
  type TextContent,
  type ToolCall,
  type ToolDefinition,
  type ToolResultMessage,
} from "./types.js";

function labError(lab: string): Error {
  return new Error(`${lab} 尚未实现`);
}

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

/**
 * 这是 Chapter 15 的学习脚手架，不是参考实现：第 06 章的 validator、Schema
 * 与 executor 原样保留，只有 exposure 推导出的两个集合与作用域把门留作 Lab 15.1。
 *
 * 工具暴露级别，与上游 Pi 1.0 同名：
 * - direct：声明给模型，也可被脚本调用（默认）；
 * - model-only：只声明给模型，脚本不能调用（如 tool_search、codemode 本身）；
 * - codemode / deferred：注册即可被脚本调用，但不声明给模型；
 *   `tool_search` 激活后才进入声明集合。两者在本课程只在“由谁激活”上区分；
 * - hidden：既不声明也不能调用。
 */
export type ToolExposure =
  | "direct"
  | "model-only"
  | "codemode"
  | "deferred"
  | "hidden";

/** 谁在发起调用：模型只能调用声明集合，脚本只能调用可调用集合。 */
export type ToolCallScope = "model" | "script";

export interface Tool<TParameters = unknown, TDetails = unknown> {
  name: string;
  description: string;
  schema: Schema<TParameters>;
  /** 缺省为 direct。 */
  exposure?: ToolExposure;
  execute(
    parameters: TParameters,
    context: ToolContext,
  ): Promise<ToolOutput<TDetails>>;
}

function definitionOf(tool: Tool<unknown, unknown>): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.schema.jsonSchema ?? { type: "object" },
  };
}

/**
 * 同一张注册表推导出两个集合：声明集合（模型看得到的）与可调用集合
 * （脚本能执行的）。direct 与 model-only 工具注册即激活；codemode 与
 * deferred 工具只有被激活后才声明；hidden 永远不激活。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool<unknown, unknown>>();
  private readonly active = new Set<string>();

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
    // Lab 15.1：direct 与 model-only 注册即激活；codemode / deferred 等待激活；hidden 永不激活。
    throw labError("Lab 15.1 ToolRegistry.register exposure");
  }

  get(name: string): Tool<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  list(): Tool<unknown, unknown>[] {
    return [...this.tools.values()];
  }

  exposureOf(_name: string): ToolExposure | undefined {
    throw labError("Lab 15.1 ToolRegistry.exposureOf");
  }

  /** 是否有任何工具的 exposure 不是 direct：只有这时声明集合才可能与全集不同。 */
  usesExposure(): boolean {
    throw labError("Lab 15.1 ToolRegistry.usesExposure");
  }

  /** 把 codemode / deferred 工具加入声明集合；未知与 hidden 名字被忽略。返回新激活的名字。 */
  activate(_names: readonly string[]): string[] {
    throw labError("Lab 15.1 ToolRegistry.activate");
  }

  isActive(_name: string): boolean {
    throw labError("Lab 15.1 ToolRegistry.isActive");
  }

  /** 声明集合：已激活且非 hidden 的工具，按注册顺序。 */
  declared(): Tool<unknown, unknown>[] {
    throw labError("Lab 15.1 ToolRegistry.declared");
  }

  /** 可调用集合（脚本视角）：全部 codemode / deferred 工具，加上已激活的 direct 工具。 */
  callable(): Tool<unknown, unknown>[] {
    throw labError("Lab 15.1 ToolRegistry.callable");
  }

  canCall(_name: string, _scope: ToolCallScope): boolean {
    throw labError("Lab 15.1 ToolRegistry.canCall");
  }

  /** 交给模型的工具清单，就是声明集合。 */
  definitions(): ToolDefinition[] {
    return this.declared().map(definitionOf);
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

/** Lab 15.1：按 scope 用 canCall 把门；不允许时返回错误原因，允许时返回 undefined。 */
function scopeDenial(
  _registry: ToolRegistry,
  _name: string,
  _scope: ToolCallScope,
): Error | undefined {
  throw labError("Lab 15.1 executeToolCall scope");
}

/**
 * 模型发起的调用只能命中声明集合，脚本发起的调用只能命中可调用集合；
 * 两者之外的名字与未知工具一样，得到配对的错误结果而不是异常。
 */
export async function executeToolCall(
  call: ToolCall,
  registry: ToolRegistry,
  context: Omit<ToolContext, "callId"> = {},
  scope: ToolCallScope = "model",
): Promise<ToolResultMessage> {
  const tool = registry.get(call.name);
  if (!tool) return failedResult(call, new Error("未知工具"));
  const denied = scopeDenial(registry, call.name, scope);
  if (denied) return failedResult(call, denied);

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
