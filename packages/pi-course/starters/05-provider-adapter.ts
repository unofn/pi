import {
  EMPTY_USAGE,
  type AgentContext,
  type Model,
  type ToolDefinition,
  type Usage,
} from "./types.js";

export type ProviderChunk =
  | { type: "text"; delta: string }
  | {
      type: "tool";
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | {
      type: "finish";
      reason: "stop" | "length" | "tool_calls";
      usage?: Partial<Usage>;
    };

export interface ProviderRequest {
  model: string;
  messages: ProviderWireMessage[];
  tools?: ProviderWireTool[];
}

export interface ProviderWireTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ProviderWireMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | {
      role: "tool";
      tool_call_id: string;
      name: string;
      content: string;
    };

export interface ProviderTransport {
  stream(
    request: ProviderRequest,
    options: { signal?: AbortSignal },
  ): AsyncIterable<ProviderChunk>;
}

export interface OpenAICompatibleTransportOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

function labError(lab: string): Error {
  return new Error(`${lab} 尚未实现`);
}

export function toProviderMessages(
  _context: AgentContext,
): ProviderWireMessage[] {
  throw labError("Lab 5.1 toProviderMessages");
}

export function toProviderTools(
  _tools: ToolDefinition[] | undefined,
): ProviderWireTool[] | undefined {
  throw labError("Lab 5.1 toProviderTools");
}

export function createOpenAICompatibleModel(_options: {
  provider: string;
  model: string;
  transport: ProviderTransport;
}): Model {
  throw labError("Lab 5.2 createOpenAICompatibleModel");
}

export function fixedTransport(
  _chunks: ProviderChunk[],
): ProviderTransport {
  throw labError("Lab 5.2 fixedTransport");
}

export function createOpenAICompatibleTransport(
  _options: OpenAICompatibleTransportOptions,
): ProviderTransport {
  throw labError("Lab 5.3 createOpenAICompatibleTransport");
}

export const ZERO_USAGE = EMPTY_USAGE;
