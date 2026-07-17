import { AssistantMessageEventStream } from "./event-stream.js";
import {
  EMPTY_USAGE,
  assistantMessage,
  currentSystemPrompt,
  type AgentContext,
  type AssistantMessage,
  type Model,
  type StopReason,
  type ToolCall,
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
  /**
   * Provider API 根地址，例如 https://api.openai.com/v1。
   * Transport 会在其后追加 /chat/completions。
   */
  baseUrl: string;
  apiKey: string;
  /**
   * 测试可以注入完全离线的 fetch；生产默认使用 globalThis.fetch。
   */
  fetch?: typeof globalThis.fetch;
}

interface ToolBuffer {
  id: string;
  name: string;
  argumentsText: string;
  contentIndex: number;
}

type ProviderFinishReason =
  Extract<ProviderChunk, { type: "finish" }>["reason"];

interface ParsedOpenAIChunk {
  chunks: Array<Exclude<ProviderChunk, { type: "finish" }>>;
  finishReason?: ProviderFinishReason;
  usage?: Partial<Usage>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidProviderChunk(detail: string): Error {
  return new Error(`Invalid provider chunk: ${detail}`);
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw invalidProviderChunk(`${path}.${key} must be a string`);
  }
  return value;
}

function optionalTokenCount(
  record: Record<string, unknown>,
  key: string,
  path: string,
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw invalidProviderChunk(
      `${path}.${key} must be a non-negative integer`,
    );
  }
  return value;
}

function parseUsage(value: unknown): Partial<Usage> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw invalidProviderChunk("usage must be an object");
  }

  const input = optionalTokenCount(value, "prompt_tokens", "usage");
  const output = optionalTokenCount(
    value,
    "completion_tokens",
    "usage",
  );
  const totalTokens = optionalTokenCount(
    value,
    "total_tokens",
    "usage",
  );
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function parseFinishReason(value: unknown): ProviderFinishReason | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "stop" || value === "length" || value === "tool_calls") {
    return value;
  }
  throw invalidProviderChunk("finish_reason is not supported");
}

function parseToolChunk(
  value: unknown,
  path: string,
): Exclude<ProviderChunk, { type: "text" | "finish" }> {
  if (!isRecord(value)) {
    throw invalidProviderChunk(`${path} must be an object`);
  }
  const index = value.index;
  if (
    typeof index !== "number" ||
    !Number.isSafeInteger(index) ||
    index < 0
  ) {
    throw invalidProviderChunk(
      `${path}.index must be a non-negative integer`,
    );
  }
  if (
    value.type !== undefined &&
    value.type !== null &&
    value.type !== "function"
  ) {
    throw invalidProviderChunk(`${path}.type must be function`);
  }

  const id = optionalString(value, "id", path);
  let name: string | undefined;
  let argumentsDelta: string | undefined;
  if (value.function !== undefined && value.function !== null) {
    if (!isRecord(value.function)) {
      throw invalidProviderChunk(`${path}.function must be an object`);
    }
    name = optionalString(value.function, "name", `${path}.function`);
    argumentsDelta = optionalString(
      value.function,
      "arguments",
      `${path}.function`,
    );
  }
  if (id === undefined && name === undefined && argumentsDelta === undefined) {
    throw invalidProviderChunk(`${path} has no tool-call delta`);
  }

  return {
    type: "tool",
    index,
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(argumentsDelta === undefined ? {} : { argumentsDelta }),
  };
}

/**
 * OpenAI-compatible JSON 仍是外部 unknown。只有通过这里的最小形状验证，
 * 才能进入课程内部的 ProviderChunk union。
 */
function parseOpenAICompatibleChunk(value: unknown): ParsedOpenAIChunk {
  if (!isRecord(value)) {
    throw invalidProviderChunk("payload must be an object");
  }
  if ("error" in value) {
    throw invalidProviderChunk("provider returned an error payload");
  }
  if (!Array.isArray(value.choices)) {
    throw invalidProviderChunk("choices must be an array");
  }
  if (value.choices.length > 1) {
    throw invalidProviderChunk("only one streamed choice is supported");
  }

  const usage = parseUsage(value.usage);
  if (value.choices.length === 0) {
    if (usage === undefined) {
      throw invalidProviderChunk("empty choices require usage");
    }
    return { chunks: [], usage };
  }

  const choice = value.choices[0];
  if (!isRecord(choice)) {
    throw invalidProviderChunk("choices[0] must be an object");
  }
  if (
    choice.index !== undefined &&
    (typeof choice.index !== "number" ||
      !Number.isSafeInteger(choice.index) ||
      choice.index < 0)
  ) {
    throw invalidProviderChunk(
      "choices[0].index must be a non-negative integer",
    );
  }
  if (!isRecord(choice.delta)) {
    throw invalidProviderChunk("choices[0].delta must be an object");
  }

  const chunks: ParsedOpenAIChunk["chunks"] = [];
  const content = choice.delta.content;
  if (content !== undefined && content !== null) {
    if (typeof content !== "string") {
      throw invalidProviderChunk(
        "choices[0].delta.content must be a string",
      );
    }
    if (content) chunks.push({ type: "text", delta: content });
  }

  const toolCalls = choice.delta.tool_calls;
  if (toolCalls !== undefined && toolCalls !== null) {
    if (!Array.isArray(toolCalls)) {
      throw invalidProviderChunk(
        "choices[0].delta.tool_calls must be an array",
      );
    }
    for (const [index, toolCall] of toolCalls.entries()) {
      chunks.push(
        parseToolChunk(
          toolCall,
          `choices[0].delta.tool_calls[${index}]`,
        ),
      );
    }
  }

  return {
    chunks,
    finishReason: parseFinishReason(choice.finish_reason),
    usage,
  };
}

function abortError(): DOMException {
  return new DOMException("Request was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (isRecord(error) && error.name === "AbortError")
  );
}

function sanitizedTransportError(error: unknown, apiKey: string): Error {
  if (isAbortError(error)) return abortError();
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = apiKey ? message.split(apiKey).join("[redacted]") : message;
  return new Error(sanitized || "OpenAI-compatible transport failed");
}

function consumeSSELine(
  line: string,
  dataLines: string[],
): string | undefined {
  if (line === "") {
    if (dataLines.length === 0) return undefined;
    const data = dataLines.join("\n");
    dataLines.length = 0;
    return data;
  }
  if (line === "data") {
    dataLines.push("");
  } else if (line.startsWith("data:")) {
    const value = line.slice(5);
    dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return undefined;
}

async function* readSSEData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const dataLines: string[] = [];
  let buffer = "";

  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });

      let lineEnd = buffer.indexOf("\n");
      while (lineEnd >= 0) {
        let line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        const data = consumeSSELine(line, dataLines);
        if (data !== undefined) yield data;
        lineEnd = buffer.indexOf("\n");
      }
      if (done) break;
    }

    if (buffer) {
      const data = consumeSSELine(
        buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer,
        dataLines,
      );
      if (data !== undefined) yield data;
    }
    if (dataLines.length > 0) {
      yield dataLines.join("\n");
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 取消只负责释放连接，不能覆盖原始解析或 abort 错误。
    }
    reader.releaseLock();
  }
}

function chatCompletionsEndpoint(baseUrl: string): string {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  try {
    return new URL(endpoint).toString();
  } catch {
    throw new Error("OpenAI-compatible baseUrl must be an absolute URL");
  }
}

/**
 * 可选的真实网络层。默认测试通过注入 fetch 完全离线；API key 只在
 * 发起请求时进入 Authorization header，不进入 context、payload 或错误。
 */
export function createOpenAICompatibleTransport(
  options: OpenAICompatibleTransportOptions,
): ProviderTransport {
  const endpoint = chatCompletionsEndpoint(options.baseUrl);
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return {
    async *stream(request, streamOptions) {
      try {
        throwIfAborted(streamOptions.signal);
        const response = await fetchImplementation(endpoint, {
          method: "POST",
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ...request,
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: streamOptions.signal,
        });
        throwIfAborted(streamOptions.signal);

        if (!response.ok) {
          throw new Error(
            `OpenAI-compatible request failed with HTTP ${response.status}`,
          );
        }
        if (!response.body) {
          throw new Error("OpenAI-compatible response has no body");
        }

        let finishReason: ProviderFinishReason | undefined;
        let usage: Partial<Usage> | undefined;
        for await (const data of readSSEData(
          response.body,
          streamOptions.signal,
        )) {
          throwIfAborted(streamOptions.signal);
          if (data.trim() === "[DONE]") break;

          let rawChunk: unknown;
          try {
            rawChunk = JSON.parse(data) as unknown;
          } catch {
            throw invalidProviderChunk("data line is not valid JSON");
          }
          const parsed = parseOpenAICompatibleChunk(rawChunk);
          if (finishReason !== undefined && parsed.chunks.length > 0) {
            throw invalidProviderChunk(
              "content arrived after finish_reason",
            );
          }
          if (
            finishReason !== undefined &&
            parsed.finishReason !== undefined &&
            finishReason !== parsed.finishReason
          ) {
            throw invalidProviderChunk(
              "finish_reason changed during the stream",
            );
          }
          for (const chunk of parsed.chunks) yield chunk;
          finishReason = parsed.finishReason ?? finishReason;
          usage =
            parsed.usage === undefined
              ? usage
              : { ...usage, ...parsed.usage };
        }
        throwIfAborted(streamOptions.signal);

        if (finishReason !== undefined) {
          yield {
            type: "finish",
            reason: finishReason,
            ...(usage === undefined ? {} : { usage }),
          };
        }
      } catch (error) {
        throw sanitizedTransportError(error, options.apiKey);
      }
    },
  };
}

function textValue(
  content: Array<{ type: string; text?: string }>,
): string {
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

/**
 * OpenAI-compatible wire 只接受一条开头的 system message。transcript 里的
 * system message 在这里按顺序重放并折叠成一条；中途的 system message 不出线。
 * 折叠只发生在请求出线那一刻，结果从不回写 transcript。
 */
export function toProviderMessages(
  context: AgentContext,
): ProviderWireMessage[] {
  const result: ProviderWireMessage[] = [];
  const systemPrompt = currentSystemPrompt(context.messages);
  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const message of context.messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      result.push({ role: "user", content: textValue(message.content) });
    } else if (message.role === "toolResult") {
      result.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        name: message.toolName,
        content: textValue(message.content),
      });
    } else {
      const textContent = textValue(message.content);
      const toolCalls = message.content
        .filter((block) => block.type === "toolCall")
        .map((call) => ({
          id: call.id,
          type: "function" as const,
          function: {
            name: call.name,
            arguments:
              call.rawArguments ?? JSON.stringify(call.arguments ?? {}),
          },
        }));
      result.push({
        role: "assistant",
        content: textContent || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }
  }
  return result;
}

export function toProviderTools(
  tools: ToolDefinition[] | undefined,
): ProviderWireTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function normalizeUsage(value?: Partial<Usage>): Usage {
  const input = value?.input ?? 0;
  const output = value?.output ?? 0;
  return {
    input,
    output,
    totalTokens: value?.totalTokens ?? input + output,
  };
}

function errorMessage(
  provider: string,
  model: string,
  reason: "error" | "aborted",
  message: string,
  partial: AssistantMessage["content"],
): AssistantMessage {
  return assistantMessage(partial, reason, {
    provider,
    model,
    errorMessage: message,
  });
}

/**
 * Adapter 的职责只有翻译：provider 专属 chunk 到 canonical events。
 * 重试、tool 执行和 transcript 更新都不属于这个边界。
 */
export function createOpenAICompatibleModel(options: {
  provider: string;
  model: string;
  transport: ProviderTransport;
}): Model {
  return {
    stream(context, streamOptions = {}) {
      const stream = new AssistantMessageEventStream();

      void (async () => {
        const content: AssistantMessage["content"] = [];
        const toolBuffers = new Map<number, ToolBuffer>();
        let textContentIndex: number | undefined;
        let textValue = "";
        let finish:
          | Extract<ProviderChunk, { type: "finish" }>
          | undefined;
        const initial = assistantMessage([], "stop", {
          provider: options.provider,
          model: options.model,
        });
        stream.push({ type: "start", partial: initial });

        try {
          for await (const chunk of options.transport.stream(
            {
              model: options.model,
              messages: toProviderMessages(context),
              tools: toProviderTools(context.tools),
            },
            streamOptions,
          )) {
            if (streamOptions.signal?.aborted) {
              throw new DOMException("Request was aborted", "AbortError");
            }

            if (chunk.type === "text") {
              if (textContentIndex === undefined) {
                textContentIndex = content.length;
                content.push({ type: "text", text: "" });
              }
              textValue += chunk.delta;
              content[textContentIndex] = {
                type: "text",
                text: textValue,
              };
              const partial = assistantMessage(
                structuredClone(content),
                "stop",
                { provider: options.provider, model: options.model },
              );
              stream.push({
                type: "text_delta",
                contentIndex: textContentIndex,
                delta: chunk.delta,
                partial,
              });
            } else if (chunk.type === "tool") {
              let buffer = toolBuffers.get(chunk.index);
              if (!buffer) {
                buffer = {
                  id: chunk.id ?? `call-${chunk.index}`,
                  name: chunk.name ?? "",
                  argumentsText: "",
                  contentIndex: content.length,
                };
                toolBuffers.set(chunk.index, buffer);
                content.push({
                  type: "toolCall",
                  id: buffer.id,
                  name: buffer.name,
                  arguments: "",
                  rawArguments: "",
                });
              }
              if (chunk.id) buffer.id = chunk.id;
              if (chunk.name) buffer.name = chunk.name;
              buffer.argumentsText += chunk.argumentsDelta ?? "";
              content[buffer.contentIndex] = {
                type: "toolCall",
                id: buffer.id,
                name: buffer.name,
                arguments: buffer.argumentsText,
                rawArguments: buffer.argumentsText,
              };
              stream.push({
                type: "toolcall_delta",
                contentIndex: buffer.contentIndex,
                delta: chunk.argumentsDelta ?? "",
                partial: assistantMessage(structuredClone(content), "stop", {
                  provider: options.provider,
                  model: options.model,
                }),
              });
            } else {
              finish = chunk;
            }
          }

          if (!finish) {
            throw new Error("Provider stream ended without a finish chunk");
          }

          const stopReason: Extract<
            StopReason,
            "stop" | "length" | "toolUse"
          > =
            finish.reason === "tool_calls"
              ? "toolUse"
              : finish.reason === "length"
                ? "length"
                : "stop";

          for (const [index, buffer] of [...toolBuffers].sort(
            ([, left], [, right]) => left.contentIndex - right.contentIndex,
          )) {
            let parsedArguments: unknown = buffer.argumentsText;
            if (stopReason === "toolUse") {
              try {
                parsedArguments = JSON.parse(buffer.argumentsText || "{}");
              } catch {
                throw new Error(
                  `Tool ${buffer.name || index} arguments 不是完整 JSON`,
                );
              }
            }
            const toolCall: ToolCall = {
              type: "toolCall",
              id: buffer.id,
              name: buffer.name,
              arguments: parsedArguments,
              rawArguments: buffer.argumentsText,
            };
            content[buffer.contentIndex] = toolCall;
            stream.push({
              type: "toolcall_end",
              contentIndex: buffer.contentIndex,
              toolCall,
              partial: assistantMessage(structuredClone(content), stopReason, {
                provider: options.provider,
                model: options.model,
              }),
            });
          }

          const message = assistantMessage(content, stopReason, {
            provider: options.provider,
            model: options.model,
            usage: normalizeUsage(finish.usage),
          });
          stream.push({ type: "done", reason: stopReason, message });
          stream.end(message);
        } catch (error) {
          const aborted =
            streamOptions.signal?.aborted ||
            (error instanceof DOMException && error.name === "AbortError");
          const message = errorMessage(
            options.provider,
            options.model,
            aborted ? "aborted" : "error",
            error instanceof Error ? error.message : String(error),
            structuredClone(content),
          );
          stream.push({
            type: "error",
            reason: aborted ? "aborted" : "error",
            error: message,
          });
          stream.end(message);
        }
      })();

      return stream;
    },
  };
}

export function fixedTransport(
  chunks: ProviderChunk[],
): ProviderTransport {
  return {
    async *stream() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

export const ZERO_USAGE = EMPTY_USAGE;
