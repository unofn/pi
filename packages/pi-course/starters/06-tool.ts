import type {
  TextContent,
  ToolCall,
  ToolDefinition,
  ToolResultMessage,
} from "./types.js";

export interface Schema<T> {
  parse(value: unknown): T;
  jsonSchema?: Record<string, unknown>;
}

export type Validator<T> = ((value: unknown) => T) & {
  jsonSchema?: Record<string, unknown>;
  optional?: boolean;
};

function labError(lab: string): Error {
  return new Error(`${lab} 尚未实现`);
}

export const stringValue = ((_value: unknown): string => {
  throw labError("Lab 6.1 stringValue");
}) as Validator<string>;

export const optionalString = ((
  _value: unknown,
): string | undefined => {
  throw labError("Lab 6.1 optionalString");
}) as Validator<string | undefined>;

export const optionalPositiveInteger = ((
  _value: unknown,
): number | undefined => {
  throw labError("Lab 6.1 optionalPositiveInteger");
}) as Validator<number | undefined>;

export function objectSchema<
  TShape extends Record<string, Validator<unknown>>,
>(_shape: TShape): Schema<{
  [TKey in keyof TShape]: ReturnType<TShape[TKey]>;
}> {
  throw labError("Lab 6.1 objectSchema");
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
  constructor(_tools: Tool<never, unknown>[] | Tool[] = []) {}

  register<TParameters, TDetails>(
    _tool: Tool<TParameters, TDetails>,
  ): void {
    throw labError("Lab 6.2 ToolRegistry.register");
  }

  get(_name: string): Tool<unknown, unknown> | undefined {
    throw labError("Lab 6.2 ToolRegistry.get");
  }

  list(): Tool<unknown, unknown>[] {
    throw labError("Lab 6.2 ToolRegistry.list");
  }

  definitions(): ToolDefinition[] {
    throw labError("Lab 6.2 ToolRegistry.definitions");
  }
}

export async function executeToolCall(
  _call: ToolCall,
  _registry: ToolRegistry,
  _context: Omit<ToolContext, "callId"> = {},
): Promise<ToolResultMessage> {
  throw labError("Lab 6.3 executeToolCall");
}
