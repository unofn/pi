import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRuntime, type RuntimeConfig, type RuntimeDeps } from "../src/composition.js";
import {
  createInMemoryTransportPair,
  InMemoryTransport,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  LATEST_PROTOCOL_VERSION,
  McpAbortError,
  McpClient,
  McpConnectionClosedError,
  McpError,
  McpTimeoutError,
  parseJsonRpcMessage,
  splitJsonRpcLines,
  StdioTransport,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "../src/mcp.js";
import {
  createMcpRuntime,
  createMcpToolName,
  MCP_SERVERS_SECTION,
  renderMcpServersSection,
} from "../src/mcp-runtime.js";
import type { ResourceCatalog } from "../src/resources.js";
import { ScriptedModel } from "../src/scripted-model.js";
import type { SessionEntry, SessionStore } from "../src/session.js";
import { executeToolCall, ToolRegistry } from "../src/tool.js";
import { createToolSearchTool, TOOL_SEARCH_TOOL_NAME } from "../src/tool-search.js";
import {
  assistantMessage,
  currentSystemMessage,
  text,
  userMessage,
  type SystemMessage,
  type ToolCall,
} from "../src/types.js";

const SLOW = { timeout: 10_000 };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface FakeServerOptions {
  protocolVersion?: string;
  /** 每页的工具；页间 cursor 由 cursors 给出。 */
  pages?: { tools: unknown[]; nextCursor?: string | null }[];
  /** 不回答这些方法（模拟挂起）。 */
  silent?: string[];
  /** initialize 在这个 promise 完成后才回答。 */
  gate?: Promise<void>;
  onCall?(name: string, args: unknown): unknown;
}

interface FakeServer {
  received: JsonRpcMessage[];
  requests(method: string): JsonRpcRequest[];
}

/** 一个只有握手、tools/list 与 tools/call 的内存 MCP 服务器。 */
function serveMcp(transport: InMemoryTransport, options: FakeServerOptions = {}): FakeServer {
  const received: JsonRpcMessage[] = [];
  const pages = options.pages ?? [{ tools: [] }];
  const respond = (id: JsonRpcRequest["id"], result: unknown) =>
    transport.send({ jsonrpc: "2.0", id, result });
  const fail = (id: JsonRpcRequest["id"], code: number, message: string) =>
    transport.send({ jsonrpc: "2.0", id, error: { code, message } });
  transport.onMessage((message) => {
    received.push(message);
    if (!isJsonRpcRequest(message)) return;
    if (options.silent?.includes(message.method)) return;
    void (async () => {
      if (message.method === "initialize") {
        await options.gate;
        await respond(message.id, {
          protocolVersion: options.protocolVersion ?? LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1.0" },
          instructions: "fake server",
        });
        return;
      }
      if (message.method === "tools/list") {
        const params = message.params as { cursor?: string } | undefined;
        const index = params?.cursor === undefined ? 0 : Number(params.cursor);
        const page = pages[index];
        if (!page) {
          await fail(message.id, -32602, "unknown cursor");
          return;
        }
        await respond(message.id, {
          tools: page.tools,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        });
        return;
      }
      if (message.method === "tools/call") {
        const params = message.params as { name: string; arguments?: unknown };
        try {
          const result = options.onCall
            ? options.onCall(params.name, params.arguments)
            : { content: [{ type: "text", text: `called ${params.name}` }] };
          await respond(message.id, result);
        } catch (error) {
          await fail(message.id, -32602, error instanceof Error ? error.message : String(error));
        }
        return;
      }
      await fail(message.id, -32601, `Method not found: ${message.method}`);
    })();
  });
  void transport.start();
  return {
    received,
    requests: (method) =>
      received.filter(
        (message): message is JsonRpcRequest =>
          isJsonRpcRequest(message) && message.method === method,
      ),
  };
}

function toolInfo(name: string, description = `${name} description`) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  };
}

async function connected(options: FakeServerOptions = {}, requestTimeoutMs?: number) {
  const pair = createInMemoryTransportPair();
  const server = serveMcp(pair.server, options);
  const client = new McpClient({ name: "course", version: "0", requestTimeoutMs });
  await client.connect(pair.client);
  return { client, server, pair };
}

test("Lab 17.1 · JSON-RPC 收窄：request / notification / response 的判定互斥，非法消息被拒绝", () => {
  const request = { jsonrpc: "2.0", id: 1, method: "ping" };
  const notification = { jsonrpc: "2.0", method: "notifications/initialized" };
  const success = { jsonrpc: "2.0", id: "a", result: {} };
  const failure = { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "nope" } };

  assert.equal(isJsonRpcRequest(request), true);
  assert.equal(isJsonRpcNotification(request), false);
  assert.equal(isJsonRpcResponse(request), false);
  assert.equal(isJsonRpcNotification(notification), true);
  assert.equal(isJsonRpcRequest(notification), false);
  assert.equal(isJsonRpcResponse(success), true);
  assert.equal(isJsonRpcResponse(failure), true);
  assert.equal(isJsonRpcRequest(success), false);
  assert.equal(parseJsonRpcMessage(request), request);

  for (const bad of [
    null,
    "ping",
    { jsonrpc: "1.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", id: Number.NaN, method: "ping" },
    { jsonrpc: "2.0", id: 1, result: {}, error: { code: 1, message: "x" } },
    { jsonrpc: "2.0", id: 1, error: { code: "x", message: "x" } },
    { jsonrpc: "2.0", id: 1 },
  ]) {
    assert.throws(() => parseJsonRpcMessage(bad), McpError, JSON.stringify(bad));
  }
});

test("Lab 17.1 · 内存传输成对交付：connect 先 initialize 再发 notifications/initialized，client 记录 serverInfo 与协议版本", SLOW, async () => {
  const { client, server } = await connected();

  assert.equal(client.connectionState, "connected");
  assert.deepEqual(client.serverInfo, { name: "fake", version: "1.0" });
  assert.equal(client.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.equal(client.instructions, "fake server");
  assert.deepEqual(
    server.received.map((message) => ("method" in message ? message.method : "response")),
    ["initialize", "notifications/initialized"],
  );
  const initialize = server.requests("initialize")[0]!;
  assert.deepEqual(initialize.params, {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "course", version: "0" },
  });
  assert.equal(isJsonRpcNotification(server.received[1]), true);

  await assert.rejects(client.connect(createInMemoryTransportPair().client), /connected state/);
  let closes = 0;
  client.onClose(() => {
    closes += 1;
  });
  await client.close();
  await client.close();
  assert.equal(client.connectionState, "closed");
  assert.equal(closes, 1);
});

test("Lab 17.1 · 版本协商：服务器选了不支持的版本时 connect 失败并关闭连接；已关闭的 client 拒绝新请求", SLOW, async () => {
  const pair = createInMemoryTransportPair();
  const server = serveMcp(pair.server, { protocolVersion: "1999-01-01" });
  const client = new McpClient({ name: "course", version: "0" });
  let closed = false;
  pair.client.onClose(() => {
    closed = true;
  });

  await assert.rejects(
    client.connect(pair.client),
    /unsupported protocol version 1999-01-01/,
  );
  assert.equal(client.connectionState, "closed");
  assert.equal(closed, true);
  assert.equal(server.requests("initialize").length, 1);
  assert.equal(
    server.received.some((message) => isJsonRpcNotification(message)),
    false,
    "握手失败不该发送 notifications/initialized",
  );
  await assert.rejects(client.request("ping"), McpConnectionClosedError);

  const older = createInMemoryTransportPair();
  serveMcp(older.server, { protocolVersion: "2024-11-05" });
  const compatible = new McpClient({ name: "course", version: "0" });
  await compatible.connect(older.client);
  assert.equal(compatible.protocolVersion, "2024-11-05");
  await compatible.close();
});

test("Lab 17.2 · tools/list 跟随 nextCursor 翻页，null 或空串 cursor 表示结束，结果校验 name 与 inputSchema", SLOW, async () => {
  const { client, server } = await connected({
    pages: [
      { tools: [toolInfo("alpha")], nextCursor: "1" },
      { tools: [toolInfo("beta"), toolInfo("gamma")], nextCursor: "2" },
      { tools: [toolInfo("delta")], nextCursor: null },
    ],
  });
  const tools = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["alpha", "beta", "gamma", "delta"],
  );
  assert.deepEqual(
    server.requests("tools/list").map((request) => request.params),
    [undefined, { cursor: "1" }, { cursor: "2" }],
  );
  await client.close();

  const empty = await connected({ pages: [{ tools: [toolInfo("solo")], nextCursor: "" }] });
  assert.deepEqual((await empty.client.listTools()).map((tool) => tool.name), ["solo"]);
  assert.equal(empty.server.requests("tools/list").length, 1);
  await empty.client.close();

  const invalid = await connected({ pages: [{ tools: [{ name: "broken" }] }] });
  await assert.rejects(invalid.client.listTools(), /Invalid entry in MCP tools\/list result/);
  await invalid.client.close();
});

test("Lab 17.2 · 重复 cursor 报错，避免无限翻页", SLOW, async () => {
  const { client, server } = await connected({
    pages: [
      { tools: [toolInfo("alpha")], nextCursor: "1" },
      { tools: [toolInfo("beta")], nextCursor: "1" },
    ],
  });
  await assert.rejects(client.listTools(), /duplicate cursor: 1/);
  assert.equal(server.requests("tools/list").length, 2);
  await client.close();
});

test("Lab 17.2 · tools/call 带 arguments；结果缺 content 时补空数组；服务器 error 响应变成带 code 的 McpError", SLOW, async () => {
  const { client, server } = await connected({
    onCall(name, args) {
      if (name === "echo") {
        return { content: [{ type: "text", text: JSON.stringify(args) }] };
      }
      if (name === "structured") return { structuredContent: { ok: true } };
      throw new Error(`unknown tool ${name}`);
    },
  });

  const echoed = await client.callTool("echo", { q: "hi" });
  assert.deepEqual(echoed, { content: [{ type: "text", text: '{"q":"hi"}' }] });
  assert.deepEqual(server.requests("tools/call")[0]!.params, {
    name: "echo",
    arguments: { q: "hi" },
  });

  const structured = await client.callTool("structured");
  assert.deepEqual(structured, { content: [], structuredContent: { ok: true } });
  assert.deepEqual(server.requests("tools/call")[1]!.params, { name: "structured" });

  await assert.rejects(client.callTool("missing"), (error: unknown) => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, -32602);
    assert.match(error.message, /unknown tool missing/);
    return true;
  });
  await client.close();
});

test("Lab 17.3 · 请求超时以 McpTimeoutError 拒绝并发送 notifications/cancelled；initialize 超时不发 cancelled", SLOW, async () => {
  const { client, server } = await connected({ silent: ["tools/call"] });
  await assert.rejects(client.callTool("slow", {}, { timeoutMs: 30 }), (error: unknown) => {
    assert.ok(error instanceof McpTimeoutError);
    assert.equal(error.timeoutMs, 30);
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const cancelled = server.received.filter(
    (message): message is JsonRpcNotification =>
      isJsonRpcNotification(message) && message.method === "notifications/cancelled",
  );
  assert.equal(cancelled.length, 1);
  const call = server.requests("tools/call")[0]!;
  assert.deepEqual(cancelled[0]!.params, { requestId: call.id, reason: "Request timed out" });
  assert.equal(client.connectionState, "connected", "单个请求超时不关闭连接");
  await client.close();

  const pair = createInMemoryTransportPair();
  const silentServer = serveMcp(pair.server, { silent: ["initialize"] });
  const impatient = new McpClient({ name: "course", version: "0", requestTimeoutMs: 30 });
  await assert.rejects(impatient.connect(pair.client), McpTimeoutError);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(impatient.connectionState, "closed");
  assert.equal(
    silentServer.received.some(
      (message) => isJsonRpcNotification(message) && message.method === "notifications/cancelled",
    ),
    false,
    "规范禁止取消 initialize",
  );
});

test("Lab 17.3 · 调用方 abort 以 AbortError 拒绝并发送 cancelled；传输关闭让所有在途请求以 McpConnectionClosedError 拒绝", SLOW, async () => {
  const { client, server, pair } = await connected({ silent: ["tools/call"] });
  const controller = new AbortController();
  const aborted = client.callTool("slow", {}, { signal: controller.signal });
  controller.abort("user cancelled");
  await assert.rejects(aborted, McpAbortError);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const cancelled = server.received.find(
    (message): message is JsonRpcNotification =>
      isJsonRpcNotification(message) && message.method === "notifications/cancelled",
  );
  assert.deepEqual(cancelled?.params, {
    requestId: server.requests("tools/call")[0]!.id,
    reason: "user cancelled",
  });
  await assert.rejects(
    client.callTool("slow", {}, { signal: AbortSignal.abort() }),
    McpAbortError,
  );

  const pendingA = client.callTool("slow");
  const pendingB = client.request("ping");
  let closes = 0;
  client.onClose(() => {
    closes += 1;
  });
  await pair.server.close();
  await assert.rejects(pendingA, McpConnectionClosedError);
  await assert.rejects(pendingB, McpConnectionClosedError);
  assert.equal(client.connectionState, "closed");
  assert.equal(closes, 1);
});

const STDIO_FIXTURE = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: "stdio-fixture", version: "1" } } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }] } });
  } else if (message.method === "tools/call" && message.params.name === "burst") {
    // 一次写入里有两条通知、一行垃圾与响应：分帧必须按换行逐条交付。
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { n: 1 } }) + "\\n" +
      "this is not json\\n" +
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { n: 2 } }) + "\\n" +
      JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "burst done" }] } }) + "\\n",
    );
  } else if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "echo:" + JSON.stringify(message.params.arguments) }] } });
  } else {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
});
rl.on("close", () => setTimeout(() => process.exit(0), 20));
`;

async function withFixture(
  run: (file: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-mcp-stdio-"));
  const file = path.join(directory, "server.cjs");
  await writeFile(file, STDIO_FIXTURE, "utf8");
  try {
    await run(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("Lab 17.4 · stdio 传输：与子进程 node 服务器握手、列工具、调用；close 结束子进程", SLOW, async () => {
  await withFixture(async (file) => {
    const transport = new StdioTransport({ command: process.execPath, args: [file] });
    const client = new McpClient({ name: "course", version: "0" });
    try {
      await client.connect(transport);
      assert.ok(isAlive(transport.pid));
      assert.deepEqual(client.serverInfo, { name: "stdio-fixture", version: "1" });
      assert.deepEqual((await client.listTools()).map((tool) => tool.name), ["echo"]);
      const result = await client.callTool("echo", { q: 1 });
      assert.deepEqual(result.content, [{ type: "text", text: 'echo:{"q":1}' }]);
    } finally {
      const pid = transport.pid;
      await client.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(isAlive(pid), false, "close 后子进程应退出");
    }
  });
});

test("Lab 17.4 · 分帧按换行提交：半行不解析，一次 data 里多行都交付，非 JSON 行只报 error 不断开", SLOW, async () => {
  const first = splitJsonRpcLines("", '{"jsonrpc":"2.0","method":"a"}\n{"jsonrpc":"2.0","id":1,"res');
  assert.deepEqual(first.messages, [{ jsonrpc: "2.0", method: "a" }]);
  assert.equal(first.rest, '{"jsonrpc":"2.0","id":1,"res');
  const second = splitJsonRpcLines(first.rest, 'ult":{}}\nnot json\n\n{"jsonrpc":"2.0","method":"b"}\n');
  assert.deepEqual(second.messages, [
    { jsonrpc: "2.0", id: 1, result: {} },
    { jsonrpc: "2.0", method: "b" },
  ]);
  assert.equal(second.errors.length, 1);
  assert.equal(second.rest, "");

  await withFixture(async (file) => {
    const transport = new StdioTransport({ command: process.execPath, args: [file] });
    const client = new McpClient({ name: "course", version: "0" });
    const errors: string[] = [];
    const notifications: unknown[] = [];
    client.onError((error) => errors.push(error.message));
    client.onNotification("notifications/message", (params) => notifications.push(params));
    try {
      await client.connect(transport);
      const result = await client.callTool("burst");
      assert.deepEqual(result.content, [{ type: "text", text: "burst done" }]);
      assert.deepEqual(notifications, [{ n: 1 }, { n: 2 }]);
      assert.equal(errors.length, 1);
      assert.equal(client.connectionState, "connected");
    } finally {
      await client.close();
    }
  });
});

test("Lab 17.5 · 工具命名：mcp__<server>__<tool>，非字母数字转 _，冲突或超长时加 hash 后缀并限制在 64 字符", () => {
  assert.equal(createMcpToolName("docs", "search"), "mcp__docs__search");
  assert.equal(createMcpToolName("my-server", "list.issues"), "mcp__my_server__list_issues");
  const long = createMcpToolName("server", "x".repeat(80));
  assert.equal(long.length, 64);
  assert.match(long, /^mcp__server__x+_[0-9a-f]{8}$/);
  assert.equal(long, createMcpToolName("server", "x".repeat(80)), "hash 必须稳定");
  const taken = new Set(["mcp__a__b_c"]);
  const collided = createMcpToolName("a", "b-c", (name) => taken.has(name));
  assert.notEqual(collided, "mcp__a__b_c");
  assert.match(collided, /^mcp__a__b_c_[0-9a-f]{8}$/);
  assert.notEqual(collided, createMcpToolName("a", "b.c", () => true), "不同原名的 hash 不同");
});

test("Lab 17.5 · 服务器工具按 deferred 注册，脚本可调用、模型需经 tool_search 激活；isError 结果保留内容", SLOW, async () => {
  const registry = new ToolRegistry();
  registry.register(createToolSearchTool(registry));
  const pair = createInMemoryTransportPair();
  const server = serveMcp(pair.server, {
    pages: [{ tools: [toolInfo("search_docs", "Search the documentation"), toolInfo("fail")] }],
    onCall(name, args) {
      if (name === "fail") return { content: [{ type: "text", text: "bad input" }], isError: true };
      return {
        content: [{ type: "text", text: `found ${JSON.stringify(args)}` }, { type: "image", data: "..." }],
      };
    },
  });
  const mcp = createMcpRuntime(registry, {
    servers: [{ name: "docs", createTransport: () => pair.client }],
  });
  try {
    await mcp.waitForDirectServers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(mcp.status(), [
      { name: "docs", state: "connected", tools: ["mcp__docs__search_docs", "mcp__docs__fail"] },
    ]);
    assert.equal(registry.exposureOf("mcp__docs__search_docs"), "deferred");
    assert.deepEqual(registry.definitions().map((tool) => tool.name), [TOOL_SEARCH_TOOL_NAME]);
    assert.deepEqual(registry.get("mcp__docs__search_docs")!.schema.jsonSchema, {
      type: "object",
      properties: { q: { type: "string" } },
    });

    const call: ToolCall = {
      type: "toolCall",
      id: "c1",
      name: "mcp__docs__search_docs",
      arguments: { q: "mcp" },
    };
    const fromModel = await executeToolCall(call, registry);
    assert.equal(fromModel.isError, true);
    assert.equal(server.requests("tools/call").length, 0);
    const fromScript = await executeToolCall(call, registry, {}, "script");
    assert.equal(fromScript.isError, false);
    assert.deepEqual(fromScript.content, [
      text('found {"q":"mcp"}'),
      text('{"type":"image","data":"..."}'),
    ]);
    assert.deepEqual(fromScript.details, { server: "docs", tool: "search_docs" });

    const search = await executeToolCall(
      { type: "toolCall", id: "s1", name: TOOL_SEARCH_TOOL_NAME, arguments: { query: "documentation search" } },
      registry,
    );
    assert.deepEqual(search.details, { loaded: ["mcp__docs__search_docs"] });
    const activated = await executeToolCall({ ...call, id: "c2" }, registry);
    assert.equal(activated.isError, false);

    const failed = await executeToolCall(
      { type: "toolCall", id: "c3", name: "mcp__docs__fail", arguments: {} },
      registry,
      {},
      "script",
    );
    assert.equal(failed.isError, true);
    assert.deepEqual(failed.content, [text("bad input")]);
  } finally {
    await mcp.close();
  }
  assert.equal(mcp.status()[0]!.state, "closed");
});

function emptyResources(): ResourceCatalog {
  return { resources: [], instructions: [], skills: [], templates: [] };
}

class RecordingSessionStore implements SessionStore {
  readonly committed: SessionEntry[] = [];

  async append(entry: SessionEntry): Promise<void> {
    this.committed.push(structuredClone(entry));
  }

  async entries(): Promise<SessionEntry[]> {
    return structuredClone(this.committed);
  }
}

function runtimeDeps(model: ScriptedModel, overrides: Partial<RuntimeDeps>): RuntimeDeps {
  let id = 0;
  let now = 100;
  return {
    model,
    tools: new ToolRegistry(),
    session: new RecordingSessionStore(),
    resources: emptyResources(),
    createId: () => `entry-${++id}`,
    now: () => ++now,
    ...overrides,
  };
}

const CONFIG: RuntimeConfig = {
  activeLeafId: null,
  systemPrompt: "BASE",
  maxSteps: 4,
  context: { total: 10_000, reservedOutput: 0, safetyMargin: 0, estimateTokens: () => 1 },
};

test("Lab 17.5 · mcp_servers 段落只在变化时打补丁；首个 prompt 只等待有 direct 工具的服务器，且等待有上限", SLOW, async () => {
  const registry = new ToolRegistry();
  const docsPair = createInMemoryTransportPair();
  serveMcp(docsPair.server, { pages: [{ tools: [toolInfo("search")] }] });
  const gate = deferred<void>();
  const slowPair = createInMemoryTransportPair();
  serveMcp(slowPair.server, { pages: [{ tools: [toolInfo("run")] }], gate: gate.promise });
  const neverPair = createInMemoryTransportPair();
  serveMcp(neverPair.server, { silent: ["initialize"] });
  const mcp = createMcpRuntime(registry, {
    startupTimeoutMs: 60,
    requestTimeoutMs: 5_000,
    servers: [
      { name: "docs", createTransport: () => docsPair.client },
      { name: "slow", createTransport: () => slowPair.client, exposure: "direct" },
      { name: "never", createTransport: () => neverPair.client },
    ],
  });
  const model = new ScriptedModel([
    assistantMessage([text("one")]),
    assistantMessage([text("two")]),
    assistantMessage([text("three")]),
  ]);
  const session = new RecordingSessionStore();
  const runtime = await createRuntime(
    CONFIG,
    runtimeDeps(model, { tools: registry, session, sectionProviders: [mcp] }),
  );
  const systemEntries = () =>
    session.committed.flatMap((entry) =>
      entry.type === "message" && entry.message.role === "system" ? [entry.message] : [],
    );
  /** 只看带段落的 system message：工具声明补丁（第 15 章）另算。 */
  const sectionEntries = () => systemEntries().filter((message) => message.sections !== undefined);
  const sectionOf = (message: SystemMessage) => message.sections?.[MCP_SERVERS_SECTION];
  try {
    const started = Date.now();
    await runtime.prompt("first");
    const waited = Date.now() - started;
    assert.ok(waited >= 50 && waited < 2_000, `等待应有上限，实际 ${waited}ms`);
    assert.equal(systemEntries().length, 1);
    const first = sectionOf(sectionEntries()[0]!)!;
    assert.match(first, /- docs: connected, 1 tool \(mcp__docs__search\)/);
    assert.match(first, /- slow: connecting, 0 tools/);
    assert.match(first, /- never: connecting, 0 tools/);
    assert.deepEqual(registry.definitions(), [], "deferred 工具不进入声明集合");

    await runtime.prompt("second");
    assert.equal(systemEntries().length, 1, "服务器状态没变就不打补丁");
    assert.equal(model.requests[1]!.messages.filter((message) => message.role === "system").length, 1);

    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.prompt("third");
    assert.equal(sectionEntries().length, 2, "slow 连上后段落变了，才有第二条段落补丁");
    const patch = sectionEntries()[1]!;
    assert.deepEqual(Object.keys(patch.sections ?? {}), [MCP_SERVERS_SECTION]);
    assert.match(sectionOf(patch)!, /- slow: connected, 1 tool \(mcp__slow__run\)/);
    assert.equal(sectionOf(patch), renderMcpServersSection(mcp.status()));
    // direct 工具进入声明集合，所以第 15 章的 loop 还追加了一条工具声明补丁。
    assert.deepEqual(registry.definitions().map((tool) => tool.name), ["mcp__slow__run"]);
    const declarations = systemEntries().filter((message) => message.toolsAdded !== undefined);
    assert.equal(declarations.length, 1);
    assert.deepEqual(declarations[0]!.toolsAdded!.map((tool) => tool.name), ["mcp__slow__run"]);
    assert.equal(systemEntries().length, 3);
    const replayed = currentSystemMessage(runtime.control.getState().messages)!;
    assert.equal(replayed.content, "BASE");
    assert.equal(sectionOf(replayed), sectionOf(patch));
  } finally {
    await runtime.dispose();
    await mcp.close();
  }
});
