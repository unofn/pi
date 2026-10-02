import { spawn, type ChildProcess } from "node:child_process";

/* ------------------------------------------------------------------ */
/* Lab 17.1 · JSON-RPC 2.0 与传输                                      */
/* ------------------------------------------------------------------ */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export class McpError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.data = data;
  }
}

export class McpConnectionClosedError extends Error {
  constructor(message = "MCP connection closed") {
    super(message);
    this.name = "McpConnectionClosedError";
  }
}

export class McpTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`MCP request timed out after ${timeoutMs}ms`);
    this.name = "McpTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class McpAbortError extends Error {
  constructor(message = "MCP request aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    isObject(value) &&
    value.jsonrpc === "2.0" &&
    isJsonRpcId(value.id) &&
    typeof value.method === "string"
  );
}

export function isJsonRpcNotification(
  value: unknown,
): value is JsonRpcNotification {
  return (
    isObject(value) &&
    value.jsonrpc === "2.0" &&
    !("id" in value) &&
    typeof value.method === "string"
  );
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!isObject(value) || value.jsonrpc !== "2.0" || !isJsonRpcId(value.id)) {
    return false;
  }
  if ("result" in value) return !("error" in value);
  if (!("error" in value) || !isObject(value.error)) return false;
  return (
    typeof value.error.code === "number" &&
    typeof value.error.message === "string"
  );
}

/** 把外部 unknown 收窄成三种 JSON-RPC 消息之一；都不是则抛 invalidRequest。 */
export function parseJsonRpcMessage(value: unknown): JsonRpcMessage {
  if (
    isJsonRpcRequest(value) ||
    isJsonRpcNotification(value) ||
    isJsonRpcResponse(value)
  ) {
    return value;
  }
  throw new McpError(
    JSON_RPC_ERROR_CODES.invalidRequest,
    "Invalid JSON-RPC message",
  );
}

export interface McpTransport {
  start(): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
  onMessage(listener: (message: JsonRpcMessage) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onClose(listener: () => void): () => void;
}

/** 传输共用的监听器簿记；emitClose 每个传输最多触发一次。 */
export abstract class TransportEvents {
  private readonly messageListeners = new Set<(message: JsonRpcMessage) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closeEmitted = false;

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  protected emitMessage(message: JsonRpcMessage): void {
    for (const listener of [...this.messageListeners]) listener(message);
  }

  protected emitError(error: unknown): void {
    const normalized = toError(error);
    for (const listener of [...this.errorListeners]) listener(normalized);
  }

  protected emitClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    for (const listener of [...this.closeListeners]) listener();
  }
}

/** 测试用的内存传输：成对连接，消息深复制后在下一个 microtask 交付给对端。 */
export class InMemoryTransport extends TransportEvents implements McpTransport {
  private peer: InMemoryTransport | undefined;
  private started = false;
  private closed = false;

  connectPeer(peer: InMemoryTransport): void {
    if (this.peer) throw new Error("In-memory MCP transport already has a peer");
    this.peer = peer;
  }

  async start(): Promise<void> {
    if (this.closed) throw new McpConnectionClosedError();
    this.started = true;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.started || this.closed) throw new McpConnectionClosedError();
    const peer = this.peer;
    if (!peer?.started || peer.closed) {
      throw new McpConnectionClosedError("In-memory MCP peer is not connected");
    }
    const copy = structuredClone(message);
    queueMicrotask(() => peer.deliver(copy));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.emitClose();
    await this.peer?.close();
  }

  /** 暴露给测试模拟传输层故障。 */
  override emitError(error: unknown): void {
    super.emitError(error);
  }

  private deliver(message: JsonRpcMessage): void {
    if (this.closed) return;
    this.emitMessage(message);
  }
}

export function createInMemoryTransportPair(): {
  client: InMemoryTransport;
  server: InMemoryTransport;
} {
  const client = new InMemoryTransport();
  const server = new InMemoryTransport();
  client.connectPeer(server);
  server.connectPeer(client);
  return { client, server };
}

/* ------------------------------------------------------------------ */
/* Lab 17.4 · stdio 传输：换行分隔的 JSON-RPC                           */
/* ------------------------------------------------------------------ */

export interface StdioTransportOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  /** stdin 关闭后给服务器自行退出的时间，之后 SIGTERM；缺省 200。 */
  graceMs?: number;
  /** SIGTERM 后等待退出的时间，之后 SIGKILL；缺省 1000。 */
  closeTimeoutMs?: number;
}

/**
 * 换行分帧：只有以 `\n` 结束的行才解析（与第 10 章 JSONL 的提交规则同构）；
 * 一次 data 里的多行都交付；不是 JSON 或不是 JSON-RPC 的行只报 error，不断开。
 */
export function splitJsonRpcLines(
  buffered: string,
  chunk: string,
): { messages: JsonRpcMessage[]; errors: Error[]; rest: string } {
  const combined = buffered + chunk;
  const lines = combined.split("\n");
  const rest = lines.pop() ?? "";
  const messages: JsonRpcMessage[] = [];
  const errors: Error[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      messages.push(parseJsonRpcMessage(JSON.parse(trimmed)));
    } catch (error) {
      errors.push(toError(error));
    }
  }
  return { messages, errors, rest };
}

export class StdioTransport extends TransportEvents implements McpTransport {
  readonly options: Readonly<StdioTransportOptions>;
  private child: ChildProcess | undefined;
  private buffered = "";
  private started = false;
  private closed = false;
  private exited: Promise<void> | undefined;

  constructor(options: StdioTransportOptions) {
    super();
    this.options = Object.freeze({ ...options, args: [...(options.args ?? [])] });
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("MCP stdio transport already started");
    if (this.closed) throw new McpConnectionClosedError();
    this.started = true;
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stdin?.on("error", (error) => {
      if (!this.closed) this.emitError(error);
    });
    this.exited = new Promise<void>((resolve) => {
      child.on("close", () => {
        this.child = undefined;
        if (this.buffered.trim().length > 0) {
          this.emitError(
            new Error("MCP stdio server closed with an incomplete JSON-RPC message"),
          );
        }
        this.buffered = "";
        this.emitClose();
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    child.on("error", (error) => {
      if (!this.closed) this.emitError(error);
    });
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!this.started || this.closed || !stdin?.writable) {
      throw new McpConnectionClosedError();
    }
    const payload = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      stdin.write(payload, (error) => (error ? reject(error) : resolve()));
    });
  }

  /** 先关 stdin 让服务器自行退出；逾期 SIGTERM，再逾期 SIGKILL。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.emitClose();
      return;
    }
    child.stdin?.end();
    const exited = this.exited ?? Promise.resolve();
    const graceMs = this.options.graceMs ?? 200;
    const closeTimeoutMs = this.options.closeTimeoutMs ?? 1_000;
    if (await raced(exited, graceMs)) return;
    child.kill("SIGTERM");
    if (await raced(exited, closeTimeoutMs)) return;
    child.kill("SIGKILL");
    await exited;
  }

  private handleStdout(chunk: string): void {
    const { messages, errors, rest } = splitJsonRpcLines(this.buffered, chunk);
    this.buffered = rest;
    for (const error of errors) this.emitError(error);
    for (const message of messages) {
      if (!this.closed) this.emitMessage(message);
    }
  }
}

/** promise 在 timeoutMs 内完成则 true，否则 false。 */
function raced(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Lab 17.1–17.3 · MCP client：initialize、tools/list、tools/call、超时与取消 */
/* ------------------------------------------------------------------ */

export const LATEST_PROTOCOL_VERSION = "2025-11-25";
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

export interface McpImplementation {
  name: string;
  version: string;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: McpImplementation;
  instructions?: string;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: string; [key: string]: unknown };

export interface McpCallToolResult {
  content: McpContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpClientOptions extends McpImplementation {
  requestTimeoutMs?: number;
}

export interface McpRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type McpConnectionState = "idle" | "connecting" | "connected" | "closed";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_LIST_PAGES = 1_000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timer: ReturnType<typeof setTimeout> | undefined;
  signal: AbortSignal | undefined;
  onAbort(): void;
  /** 规范禁止取消 initialize。 */
  cancellable: boolean;
}

function invalid(message: string): McpError {
  return new McpError(JSON_RPC_ERROR_CODES.invalidRequest, message);
}

function validateInitializeResult(value: unknown): McpInitializeResult {
  if (
    !isObject(value) ||
    typeof value.protocolVersion !== "string" ||
    !isObject(value.capabilities) ||
    !isObject(value.serverInfo) ||
    typeof value.serverInfo.name !== "string" ||
    typeof value.serverInfo.version !== "string" ||
    (value.instructions !== undefined && typeof value.instructions !== "string")
  ) {
    throw invalid("Invalid MCP initialize result");
  }
  return value as unknown as McpInitializeResult;
}

/** 一页 tools/list：校验每个工具的 name 与 inputSchema；null / "" cursor 视为结束。 */
export function validateToolsPage(value: unknown): {
  tools: McpToolInfo[];
  nextCursor?: string;
} {
  if (!isObject(value) || !Array.isArray(value.tools)) {
    throw invalid("Invalid MCP tools/list result");
  }
  for (const tool of value.tools) {
    if (!isObject(tool) || typeof tool.name !== "string" || !isObject(tool.inputSchema)) {
      throw invalid("Invalid entry in MCP tools/list result");
    }
  }
  const nextCursor =
    value.nextCursor === null || value.nextCursor === ""
      ? undefined
      : value.nextCursor;
  if (nextCursor !== undefined && typeof nextCursor !== "string") {
    throw invalid("Invalid MCP tools/list cursor");
  }
  return {
    tools: value.tools as McpToolInfo[],
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

/** `content` 按规范必填，但只返回 structuredContent 的服务器会省略它。 */
function validateCallToolResult(value: unknown): McpCallToolResult {
  if (!isObject(value) || (value.content !== undefined && !Array.isArray(value.content))) {
    throw invalid("Invalid MCP tools/call result");
  }
  if (value.structuredContent !== undefined && !isObject(value.structuredContent)) {
    throw invalid("Invalid MCP tools/call structured content");
  }
  return (
    value.content === undefined ? { ...value, content: [] } : value
  ) as unknown as McpCallToolResult;
}

export class McpClient {
  readonly options: Readonly<McpClientOptions>;
  private state: McpConnectionState = "idle";
  private transport: McpTransport | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationListeners = new Map<string, Set<(params: unknown) => void>>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly closeListeners = new Set<() => void>();
  private disposers: (() => void)[] = [];
  private initializeResult: McpInitializeResult | undefined;

  constructor(options: McpClientOptions) {
    this.options = Object.freeze({ ...options });
  }

  get connectionState(): McpConnectionState {
    return this.state;
  }

  get serverInfo(): McpImplementation | undefined {
    return this.initializeResult?.serverInfo;
  }

  get protocolVersion(): string | undefined {
    return this.initializeResult?.protocolVersion;
  }

  get instructions(): string | undefined {
    return this.initializeResult?.instructions;
  }

  /**
   * 握手：start 传输 → `initialize`（带客户端期望的协议版本）→ 校验服务器选的
   * 版本在支持列表里 → `notifications/initialized`。任何一步失败都关闭连接。
   */
  async connect(transport: McpTransport): Promise<McpInitializeResult> {
    if (this.state !== "idle") {
      throw new Error(`Cannot connect MCP client in ${this.state} state`);
    }
    this.state = "connecting";
    this.transport = transport;
    this.disposers = [
      transport.onMessage((message) => this.handleMessage(message)),
      transport.onError((error) => this.emitError(error)),
      transport.onClose(() => this.markClosed()),
    ];
    try {
      await transport.start();
      const result = validateInitializeResult(
        await this.requestInternal(
          "initialize",
          {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: this.options.name, version: this.options.version },
          },
          {},
          true,
        ),
      );
      if (!SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
        throw new Error(
          `MCP server selected unsupported protocol version ${result.protocolVersion}`,
        );
      }
      this.initializeResult = result;
      await this.notifyInternal("notifications/initialized", undefined, true);
      this.state = "connected";
      return result;
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  request<TResult = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options: McpRequestOptions = {},
  ): Promise<TResult> {
    return this.requestInternal(method, params, options, false) as Promise<TResult>;
  }

  notify(method: string, params?: Record<string, unknown>): Promise<void> {
    return this.notifyInternal(method, params, false);
  }

  onNotification(method: string, listener: (params: unknown) => void): () => void {
    const listeners = this.notificationListeners.get(method) ?? new Set();
    this.notificationListeners.set(method, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  /** 连接关闭时调用一次，无论是传输断开还是主动 close。 */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** 全部工具：跟随 nextCursor 翻页；重复 cursor 或超过页数上限都报错。 */
  async listTools(options: McpRequestOptions = {}): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = validateToolsPage(
        await this.request(
          "tools/list",
          cursor === undefined ? undefined : { cursor },
          options,
        ),
      );
      tools.push(...result.tools);
      if (result.nextCursor === undefined) return tools;
      if (cursors.has(result.nextCursor)) {
        throw new Error(`MCP tools/list returned duplicate cursor: ${result.nextCursor}`);
      }
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error(`MCP tools/list exceeded ${MAX_LIST_PAGES} pages`);
  }

  async callTool(
    name: string,
    args?: Record<string, unknown>,
    options: McpRequestOptions = {},
  ): Promise<McpCallToolResult> {
    return validateCallToolResult(
      await this.request(
        "tools/call",
        { name, ...(args === undefined ? {} : { arguments: args }) },
        options,
      ),
    );
  }

  async close(): Promise<void> {
    const transport = this.transport;
    this.transport = undefined;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.markClosed();
    await transport?.close();
  }

  private async requestInternal(
    method: string,
    params: Record<string, unknown> | undefined,
    options: McpRequestOptions,
    allowConnecting: boolean,
  ): Promise<unknown> {
    const transport = this.requireTransport(allowConnecting);
    if (options.signal?.aborted) throw new McpAbortError();
    const id = this.nextRequestId++;
    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    const timeoutMs =
      options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const cancellable = method !== "initialize";
    return new Promise<unknown>((resolve, reject) => {
      const entry: PendingRequest = {
        resolve,
        reject,
        timer: undefined,
        signal: options.signal,
        onAbort: () =>
          this.cancelPending(
            id,
            new McpAbortError(),
            cancellable,
            String(options.signal?.reason ?? "Aborted"),
          ),
        cancellable,
      };
      this.pending.set(id, entry);
      options.signal?.addEventListener("abort", entry.onAbort, { once: true });
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.cancelPending(
            id,
            new McpTimeoutError(timeoutMs),
            cancellable,
            "Request timed out",
          );
        }, timeoutMs);
      }
      transport.send(message).catch((error) => this.cancelPending(id, error, false));
    });
  }

  private async notifyInternal(
    method: string,
    params: Record<string, unknown> | undefined,
    allowConnecting: boolean,
  ): Promise<void> {
    await this.requireTransport(allowConnecting).send({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  private requireTransport(allowConnecting: boolean): McpTransport {
    if (
      this.transport &&
      (this.state === "connected" ||
        (allowConnecting && this.state === "connecting"))
    ) {
      return this.transport;
    }
    throw new McpConnectionClosedError(`MCP client is ${this.state}`);
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (isJsonRpcResponse(message)) {
      const entry = this.pending.get(message.id);
      if (!entry) {
        this.emitError(new Error(`Received response for unknown MCP request ${String(message.id)}`));
        return;
      }
      this.removePending(message.id, entry);
      if ("error" in message) {
        entry.reject(new McpError(message.error.code, message.error.message, message.error.data));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (isJsonRpcNotification(message)) {
      for (const listener of this.notificationListeners.get(message.method) ?? []) {
        try {
          listener(message.params);
        } catch (error) {
          this.emitError(error);
        }
      }
      return;
    }
    if (isJsonRpcRequest(message)) {
      // 课程不处理服务器发来的请求（如 roots/list），统一回 method not found。
      const request: JsonRpcRequest = message;
      void this.transport
        ?.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: JSON_RPC_ERROR_CODES.methodNotFound,
            message: `Method not found: ${request.method}`,
          },
        })
        .catch((error) => this.emitError(error));
    }
  }

  /** 拒绝一个在途请求；需要时向服务器发 notifications/cancelled（initialize 除外）。 */
  private cancelPending(
    id: JsonRpcId,
    error: unknown,
    notifyServer: boolean,
    reason?: string,
  ): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.removePending(id, entry);
    entry.reject(error);
    if (notifyServer && this.transport) {
      void this.transport
        .send({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id, ...(reason ? { reason } : {}) },
        })
        .catch((sendError) => this.emitError(sendError));
    }
  }

  private removePending(id: JsonRpcId, entry: PendingRequest): void {
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.onAbort);
  }

  /** 幂等：拒绝全部在途请求并翻转状态；close 监听器只通知一次。 */
  private markClosed(): void {
    const wasClosed = this.state === "closed";
    this.state = "closed";
    for (const [id, entry] of this.pending) {
      this.removePending(id, entry);
      entry.reject(new McpConnectionClosedError());
    }
    if (wasClosed) return;
    for (const listener of [...this.closeListeners]) {
      try {
        listener();
      } catch (error) {
        this.emitError(error);
      }
    }
  }

  private emitError(error: unknown): void {
    const normalized = toError(error);
    for (const listener of [...this.errorListeners]) listener(normalized);
  }
}
