import { createHash } from "node:crypto";
import {
  McpClient,
  type McpCallToolResult,
  type McpToolInfo,
  type McpTransport,
} from "./mcp.js";
import type { Tool, ToolExposure, ToolRegistry } from "./tool.js";
import { text, type TextContent } from "./types.js";

/**
 * 这是 Chapter 17 的学习脚手架，不是参考实现：工具适配与段落渲染已经给出，
 * 命名与 MCP runtime 留作 Lab 17.5。
 */
function labError(lab: string): Error {
  return new Error(`${lab} 尚未实现`);
}

/* ------------------------------------------------------------------ */
/* Lab 17.5 · 接入 Runtime：命名、注册、mcp_servers 段落                 */
/* ------------------------------------------------------------------ */

/** provider 的工具名限制在 64 个 `[A-Za-z0-9_-]` 字符内。 */
const MAX_TOOL_NAME_LENGTH = 64;

/**
 * `mcp__<server>__<tool>`：非 `[A-Za-z0-9_]` 一律变成 `_`，所以它同时也是脚本里
 * `tools.<name>` 的合法标识符。`isTaken` 报告已被别的工具占用的名字：清洗可能把
 * 两个工具映射到同一个名字（`a-b` 与 `a_b`），这时和超长一样加 hash 后缀。
 */
export function createMcpToolName(
  _server: string,
  _tool: string,
  _isTaken: (name: string) => boolean = () => false,
): string {
  // Lab 17.5：清洗 → 不超长且未被占用则直接用；否则截断后加 `_` + sha256 前 8 位。
  void createHash;
  void MAX_TOOL_NAME_LENGTH;
  throw labError("Lab 17.5 createMcpToolName");
}

export interface McpToolDetails {
  server: string;
  tool: string;
}

/** 文本块原样进入内容，其他块以 JSON 文本呈现给模型。 */
export function toModelContent(result: McpCallToolResult): TextContent[] {
  return result.content.map((block) =>
    block.type === "text" && typeof block.text === "string"
      ? text(block.text)
      : text(JSON.stringify(block)),
  );
}

/** 工具的 inputSchema 必须是 object schema；缺 type 或 properties 的补齐。 */
function toParameters(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    ...schema,
    type: schema.type ?? "object",
    ...(schema.properties === undefined ? { properties: {} } : {}),
  };
}

export interface McpToolCaller {
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<McpCallToolResult>;
}

/**
 * 把一个服务器工具变成课程 Tool：参数只做“必须是 object”的收窄（服务器自己校验），
 * 执行时经 client 的 tools/call，`isError` 的结果成为错误结果但保留内容。
 */
export function createMcpTool(options: {
  server: string;
  tool: McpToolInfo;
  name: string;
  exposure: ToolExposure;
  timeoutMs?: number;
  getClient(): Promise<McpToolCaller>;
}): Tool<Record<string, unknown>, McpToolDetails> {
  const { server, tool } = options;
  return {
    name: options.name,
    description:
      tool.description?.trim() || `MCP tool ${tool.name} from server ${server}`,
    schema: {
      jsonSchema: toParameters(tool.inputSchema),
      parse(value) {
        if (value === undefined) return {};
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("参数必须是 object");
        }
        return value as Record<string, unknown>;
      },
    },
    exposure: options.exposure,
    async execute(parameters, context) {
      const client = await options.getClient();
      const result = await client.callTool(tool.name, parameters, {
        signal: context.signal,
        timeoutMs: options.timeoutMs,
      });
      const content = toModelContent(result);
      if (result.isError && content.length === 0) {
        content.push(text(`MCP tool ${server}/${tool.name} returned an error`));
      }
      return {
        content,
        details: { server, tool: tool.name },
        ...(result.isError ? { isError: true } : {}),
      };
    },
  };
}

export const MCP_SERVERS_SECTION = "mcp_servers";

export interface McpServerConfig {
  name: string;
  createTransport(): McpTransport;
  /** 服务器工具的暴露级别；缺省 deferred，由 tool_search 按需激活。 */
  exposure?: ToolExposure;
}

export type McpServerState = "connecting" | "connected" | "failed" | "closed";

export interface McpServerStatus {
  name: string;
  state: McpServerState;
  error?: string;
  /** 已注册到注册表的工具名。 */
  tools: string[];
}

export interface McpRuntimeOptions {
  servers: readonly McpServerConfig[];
  clientInfo?: { name: string; version: string };
  /** 单个请求的超时；缺省 30000。 */
  requestTimeoutMs?: number;
  /** 首个 prompt 等待有 direct 工具的服务器连上的上限；缺省 5000。 */
  startupTimeoutMs?: number;
}

export interface McpRuntime {
  /** 当前各服务器的状态快照。 */
  status(): McpServerStatus[];
  /** 只等待有 direct 工具的服务器（有上限）；其余在后台连接。 */
  waitForDirectServers(): Promise<void>;
  /** 给第 13 章 Runtime 的段落提供者：先做有上限的等待，再渲染 mcp_servers 段落。 */
  sections(): Promise<Record<string, string>>;
  close(): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 服务器清单只写状态与工具名，不写工具描述：描述变化不该重写 prompt 前缀。 */
export function renderMcpServersSection(statuses: readonly McpServerStatus[]): string {
  const lines = statuses.map((status) => {
    const tools =
      status.tools.length > 0 ? ` (${status.tools.join(", ")})` : "";
    const error = status.error ? `: ${status.error}` : "";
    return `- ${status.name}: ${status.state}${error}, ${status.tools.length} tool${status.tools.length === 1 ? "" : "s"}${tools}`;
  });
  return ["MCP servers:", ...lines].join("\n");
}

/**
 * 创建即在后台连接全部服务器；每个服务器的工具在 tools/list 之后注册为
 * `mcp__<server>__<tool>`，缺省 deferred。`sections()` 把服务器清单作为
 * `mcp_servers` 段落交给第 13 章 Runtime，它只在段落变化时打补丁。
 */
export function createMcpRuntime(
  _registry: ToolRegistry,
  _options: McpRuntimeOptions,
): McpRuntime {
  // Lab 17.5：创建即后台连接每个服务器（connect → listTools → 按 createMcpToolName 注册
  // createMcpTool，缺省 deferred）；status() 快照；waitForDirectServers 只等 direct 服务器且
  // 有 startupTimeoutMs 上限；sections() 先等待再渲染 mcp_servers；close 关闭全部 client。
  void McpClient;
  void createMcpTool;
  void renderMcpServersSection;
  void errorMessage;
  throw labError("Lab 17.5 createMcpRuntime");
}
