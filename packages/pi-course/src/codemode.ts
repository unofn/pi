import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import {
  isWorkerToHostMessage,
  type CodemodeWorkerData,
  type HostToWorkerMessage,
  type WorkerToHostMessage,
} from "./codemode-protocol.js";
import {
  executeToolCall as executeCoreToolCall,
  objectSchema,
  stringValue,
  type Tool,
  type ToolExecutor,
  type ToolRegistry,
} from "./tool.js";
import { text, textOf, type ToolCall } from "./types.js";

/* ------------------------------------------------------------------ */
/* Lab 16.1 · 沙箱：独立 worker 里的 QuickJS VM 与消息桥                */
/* ------------------------------------------------------------------ */

/**
 * 脚本里 `tools.<name>(args)` 在宿主侧对应的函数。`args` 是脚本传入值经 JSON
 * 往返后的结果；返回值必须可 JSON 序列化；抛出的错误在脚本里变成同样 message
 * 的 Error。`signal` 在脚本结束、超时、取消时触发。
 */
export type CodemodeToolFunction = (
  args: unknown,
  context: { signal: AbortSignal },
) => Promise<unknown>;

export interface CodemodeScriptTool {
  description?: string;
  execute: CodemodeToolFunction;
}

export interface CodemodeScriptOptions {
  tools?: ReadonlyMap<string, CodemodeScriptTool>;
  /** 整次执行的 deadline，含工具耗时；缺省 30000。 */
  timeoutMs?: number;
  /** VM 的内存上限；超出时脚本内得到 `InternalError: out of memory`。缺省 64 MiB。 */
  memoryLimitBytes?: number;
  signal?: AbortSignal;
}

export type CodemodeCallStatus = "ok" | "error" | "cancelled";

export interface CodemodeCall {
  name: string;
  status: CodemodeCallStatus;
}

export type CodemodeErrorKind =
  /** 脚本抛错或无法解析。name 与 stack 来自脚本里的错误。 */
  | "script"
  /** deadline 到期，worker 已 terminate。 */
  | "timeout"
  /** 调用方的 signal 触发，worker 已 terminate。 */
  | "aborted"
  /** worker 或 VM 在脚本控制之外失败（wasm trap、worker 文件缺失）。 */
  | "sandbox";

export interface CodemodeError {
  kind: CodemodeErrorKind;
  name?: string;
  message: string;
  stack?: string;
}

/** `output` 是 console.* 的文本，失败时也保留到失败为止。 */
export type CodemodeScriptResult =
  | { ok: true; value: unknown; output: string[]; calls: CodemodeCall[] }
  | { ok: false; error: CodemodeError; output: string[]; calls: CodemodeCall[] };

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;

let wasmModule: Promise<WebAssembly.Module> | undefined;

/** 读取并编译 quickjs-wasi 自带的 quickjs.wasm，进程内只做一次；失败后下次重试。 */
export function loadQuickJSWasm(): Promise<WebAssembly.Module> {
  if (!wasmModule) {
    const resolved = createRequire(import.meta.url).resolve(
      "quickjs-wasi/quickjs.wasm",
    );
    wasmModule = readFile(resolved)
      .then((bytes) => WebAssembly.compile(bytes))
      .catch((error: unknown) => {
        wasmModule = undefined;
        throw error;
      });
  }
  return wasmModule;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function workerUrl(): URL {
  return new URL("./codemode-worker.js", import.meta.url);
}

interface PendingCall {
  record: CodemodeCall;
  controller: AbortController;
}

/**
 * 一次执行 = 一个 worker + 一个 VM。每次都新建 worker，终止才简单：失控脚本
 * （包括只在 microtask 队列里自旋的）用 terminate() 杀掉，不会污染下一次执行。
 */
class Execution {
  readonly promise: Promise<CodemodeScriptResult>;
  private resolveResult!: (result: CodemodeScriptResult) => void;
  private worker: Worker | undefined;
  private readonly interrupt = new SharedArrayBuffer(4);
  private readonly tools: ReadonlyMap<string, CodemodeScriptTool>;
  private readonly signal: AbortSignal | undefined;
  private readonly timer: NodeJS.Timeout | undefined;
  private readonly output: string[] = [];
  private readonly calls: CodemodeCall[] = [];
  private readonly pending = new Map<number, PendingCall>();
  private finished = false;

  constructor(code: string, options: CodemodeScriptOptions) {
    this.promise = new Promise<CodemodeScriptResult>((resolve) => {
      this.resolveResult = resolve;
    });
    this.tools = options.tools ?? new Map();
    this.signal = options.signal;
    this.timer = this.armDeadline(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (options.signal) this.watchSignal(options.signal);
    loadQuickJSWasm().then(
      (wasm) => {
        try {
          this.start(
            code,
            options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES,
            wasm,
          );
        } catch (error) {
          this.finish({ kind: "sandbox", message: errorMessage(error) });
        }
      },
      (error: unknown) => {
        this.finish({
          kind: "sandbox",
          message: `Failed to load QuickJS: ${errorMessage(error)}`,
        });
      },
    );
  }

  /** deadline 包含工具耗时；Infinity 表示只在脚本结束或被取消时才结束。 */
  private armDeadline(timeoutMs: number): NodeJS.Timeout | undefined {
    if (!Number.isFinite(timeoutMs)) return undefined;
    return setTimeout(() => {
      this.finish({
        kind: "timeout",
        message: `Execution timed out after ${timeoutMs} ms`,
      });
    }, timeoutMs);
  }

  private watchSignal(signal: AbortSignal): void {
    if (signal.aborted) this.onAbort();
    else signal.addEventListener("abort", this.onAbort, { once: true });
  }

  private start(
    code: string,
    memoryLimitBytes: number,
    wasm: WebAssembly.Module,
  ): void {
    if (this.finished) return;
    const workerData: CodemodeWorkerData = {
      code,
      tools: [...this.tools].map(([name, tool]) => ({
        name,
        description: tool.description ?? "",
      })),
      wasm,
      memoryLimitBytes,
      interrupt: this.interrupt,
    };
    let worker: Worker;
    try {
      worker = new Worker(workerUrl(), { workerData });
    } catch (error) {
      this.finish({
        kind: "sandbox",
        message: `Failed to start worker: ${errorMessage(error)}`,
      });
      return;
    }
    // 宿主持有 promise；worker 不该阻止进程退出。
    worker.unref();
    this.worker = worker;
    worker.on("message", (message: unknown) => this.handleMessage(message));
    worker.on("error", (error: unknown) => {
      this.finish({
        kind: "sandbox",
        name: error instanceof Error ? error.name : undefined,
        message: errorMessage(error),
      });
    });
    worker.on("exit", (code) => {
      this.finish({
        kind: "sandbox",
        message: `Worker exited with code ${code} before the script settled`,
      });
    });
  }

  private readonly onAbort = (): void => {
    const reason: unknown = this.signal?.reason;
    this.finish({
      kind: "aborted",
      message: reason instanceof Error ? reason.message : "Execution aborted",
    });
  };

  private post(message: HostToWorkerMessage): void {
    this.worker?.postMessage(message);
  }

  private handleMessage(message: unknown): void {
    if (this.finished || !isWorkerToHostMessage(message)) return;
    switch (message.type) {
      case "output":
        this.output.push(message.text);
        break;
      case "call":
        void this.handleCall(message);
        break;
      case "done":
        if (message.ok) {
          this.finish(
            undefined,
            message.value === undefined ? undefined : JSON.parse(message.value),
          );
        } else {
          const parsed = JSON.parse(message.error) as Omit<CodemodeError, "kind">;
          this.finish({ kind: "script", ...parsed });
        }
        break;
      case "crash":
        this.finish({ kind: "sandbox", message: message.message });
        break;
    }
  }

  private async handleCall(
    message: Extract<WorkerToHostMessage, { type: "call" }>,
  ): Promise<void> {
    const { id, name } = message;
    const record: CodemodeCall = { name, status: "cancelled" };
    this.calls.push(record);
    const pending: PendingCall = { record, controller: new AbortController() };
    this.pending.set(id, pending);

    let status: CodemodeCallStatus;
    let reply: HostToWorkerMessage;
    try {
      const tool = this.tools.get(name);
      if (!tool) throw new Error(`Unknown tool "${name}"`);
      const args: unknown =
        message.args === undefined ? undefined : JSON.parse(message.args);
      const value = await tool.execute(args, {
        signal: pending.controller.signal,
      });
      reply = {
        type: "result",
        id,
        ok: true,
        payload: value === undefined ? undefined : JSON.stringify(value),
      };
      status = "ok";
    } catch (error) {
      reply = { type: "result", id, ok: false, payload: errorMessage(error) };
      status = "error";
    }
    // finish() 已经取消过：记录保持 cancelled，worker 已经或正在消失。
    if (!this.pending.delete(id)) return;
    record.status = status;
    this.post(reply);
  }

  private finish(error: CodemodeError | undefined, value?: unknown): void {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    this.signal?.removeEventListener("abort", this.onAbort);
    for (const pending of this.pending.values()) pending.controller.abort();
    this.pending.clear();

    const result: CodemodeScriptResult = error
      ? { ok: false, error, output: this.output, calls: this.calls }
      : { ok: true, value, output: this.output, calls: this.calls };
    if (!this.worker) {
      this.resolveResult(result);
      return;
    }
    // 先置中断标志再 terminate：正在 wasm 里自旋的 VM 也会在下一条字节码停下。
    Atomics.store(new Int32Array(this.interrupt), 0, 1);
    this.worker
      .terminate()
      .catch(() => undefined)
      .then(() => this.resolveResult(result));
  }
}

/**
 * 在 worker 线程里的 QuickJS VM 中运行一段 JavaScript。脚本看到每个工具的
 * `tools.<name>(args)`、`ALL_TOOLS` 与 `console.*`，此外什么都没有：没有计时器、
 * fetch、process、require 或模块。脚本失败不会 reject，而是 `{ ok: false }`。
 */
export function runCodemodeScript(
  code: string,
  options: CodemodeScriptOptions = {},
): Promise<CodemodeScriptResult> {
  return new Execution(code, options).promise;
}

/* ------------------------------------------------------------------ */
/* Lab 16.2 · 嵌套调用：走第 06 / 15 章的执行路径，有界记录             */
/* ------------------------------------------------------------------ */

export type NestedCallStatus = "running" | "ok" | "error" | "cancelled";

/** 一次嵌套调用在父结果上留下的记录。结果从不记录，只记状态。 */
export interface NestedCallRecord {
  id: string;
  name: string;
  status: NestedCallStatus;
  /** 参数 JSON；超过上限时省略，只记字节数。 */
  arguments?: unknown;
  argumentsBytes?: number;
  /** 失败原因的前缀。 */
  error?: string;
}

export interface NestedCallLimits {
  /** 最多记录多少次调用；超过的调用照样执行，但只计数。 */
  maxCalls: number;
  maxArgumentBytesPerCall: number;
  maxArgumentBytesTotal: number;
  maxErrorChars: number;
}

export const NESTED_CALL_LIMITS: NestedCallLimits = {
  maxCalls: 256,
  maxArgumentBytesPerCall: 8 * 1024,
  maxArgumentBytesTotal: 32 * 1024,
  maxErrorChars: 500,
};

/** 父结果上的嵌套调用摘要：`complete` 为 false 表示有记录被省略或截断。 */
export interface NestedCalls {
  calls: NestedCallRecord[];
  count: number;
  complete: boolean;
}

export interface NestedToolBridgeOptions {
  signal?: AbortSignal;
  limits?: Partial<NestedCallLimits>;
  /** 缺省直接走核心 executeToolCall；可注入第 12 章 extension host 包过的执行器。 */
  executeToolCall?: ToolExecutor;
}

export interface NestedToolBridge {
  /** 给 runCodemodeScript 的工具表：可调用集合里的每个工具。 */
  tools: Map<string, CodemodeScriptTool>;
  /** 到目前为止的记录快照。 */
  nestedCalls(): NestedCalls;
}

const encoder = new TextEncoder();

/**
 * 把注册表的可调用集合变成脚本工具表。每次脚本调用都成为一个 ToolCall，id 为
 * `<parent>/<n>`，经 `executeToolCall(call, registry, context, "script")` 走校验与
 * 执行；isError 的结果在脚本里变成抛错。脚本收到的值是 `{ text, details? }`。
 * 嵌套调用不写入 transcript，只在父结果的 nestedCalls 里留下有界记录。
 */
export function createNestedToolBridge(
  registry: ToolRegistry,
  parentCallId: string,
  options: NestedToolBridgeOptions = {},
): NestedToolBridge {
  const limits: NestedCallLimits = { ...NESTED_CALL_LIMITS, ...options.limits };
  const execute: ToolExecutor =
    options.executeToolCall ??
    ((call, context) => executeCoreToolCall(call, registry, context, "script"));
  const records: NestedCallRecord[] = [];
  let count = 0;
  let complete = true;
  let argumentBytes = 0;

  function start(call: ToolCall): NestedCallRecord | undefined {
    count += 1;
    if (records.length >= limits.maxCalls) {
      complete = false;
      return undefined;
    }
    const record: NestedCallRecord = {
      id: call.id,
      name: call.name,
      status: "running",
    };
    const json = JSON.stringify(call.arguments ?? {}) ?? "null";
    const bytes = encoder.encode(json).length;
    if (
      bytes > limits.maxArgumentBytesPerCall ||
      argumentBytes + bytes > limits.maxArgumentBytesTotal
    ) {
      record.argumentsBytes = bytes;
      complete = false;
    } else {
      record.arguments = JSON.parse(json);
      argumentBytes += bytes;
    }
    records.push(record);
    return record;
  }

  const tools = new Map<string, CodemodeScriptTool>();
  for (const tool of registry.callable()) {
    tools.set(tool.name, {
      description: tool.description,
      async execute(args, context) {
        const call: ToolCall = {
          type: "toolCall",
          id: `${parentCallId}/${count + 1}`,
          name: tool.name,
          arguments: args,
        };
        const record = start(call);
        const signal = options.signal
          ? AbortSignal.any([options.signal, context.signal])
          : context.signal;
        const settle = (status: NestedCallStatus, error?: string) => {
          if (!record) return;
          record.status = status;
          if (error !== undefined) {
            record.error = error.slice(0, limits.maxErrorChars);
          }
        };
        try {
          const result = await execute(call, { signal });
          if (result.isError) {
            const message = textOf(result);
            settle(signal.aborted ? "cancelled" : "error", message);
            throw new Error(message);
          }
          settle("ok");
          return {
            text: textOf(result),
            ...(result.details === undefined ? {} : { details: result.details }),
          };
        } catch (error) {
          if (record?.status === "running") {
            settle(signal.aborted ? "cancelled" : "error", errorMessage(error));
          }
          throw error;
        }
      },
    });
  }

  return {
    tools,
    nestedCalls: () => ({
      calls: structuredClone(records),
      count,
      complete,
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Lab 16.4 · codemode 工具：model-only，参数是一段脚本                 */
/* ------------------------------------------------------------------ */

export const CODEMODE_TOOL_NAME = "codemode";

export interface CodemodeToolDetails {
  ok: boolean;
  error?: { kind: CodemodeErrorKind; message: string };
  output: string[];
  nestedCalls: NestedCalls;
}

export interface CodemodeToolOptions {
  timeoutMs?: number;
  memoryLimitBytes?: number;
  limits?: Partial<NestedCallLimits>;
  executeToolCall?: ToolExecutor;
}

function describeTools(registry: ToolRegistry): string {
  return registry
    .callable()
    .map((tool) => `- tools.${tool.name}(args): ${tool.description.trim().split(/\r?\n/)[0]}`)
    .join("\n");
}

/**
 * `codemode` 是一个 model-only 工具：模型写一段脚本，脚本里用 `await tools.<name>(args)`
 * 调用可调用集合里的工具（包括尚未声明的 codemode / deferred 工具），`return` 的值
 * 作为结果交回模型。每次调用都是新的 worker 与 VM。
 */
export function createCodemodeTool(
  registry: ToolRegistry,
  options: CodemodeToolOptions = {},
): Tool<{ code: string }, CodemodeToolDetails> {
  return {
    name: CODEMODE_TOOL_NAME,
    description: [
      "Run a JavaScript async function body in a sandbox. Call tools with `await tools.<name>(args)`;",
      "each resolves to `{ text, details? }` or throws on error. `return` a JSON value as the result.",
      "There are no timers, fetch, or modules. Callable tools:",
      describeTools(registry),
    ].join("\n"),
    schema: objectSchema({ code: stringValue }),
    exposure: "model-only",
    async execute({ code }, context) {
      const bridge = createNestedToolBridge(registry, context.callId, {
        signal: context.signal,
        limits: options.limits,
        executeToolCall: options.executeToolCall,
      });
      const result = await runCodemodeScript(code, {
        tools: bridge.tools,
        timeoutMs: options.timeoutMs,
        memoryLimitBytes: options.memoryLimitBytes,
        signal: context.signal,
      });
      const nestedCalls = bridge.nestedCalls();
      if (result.ok) {
        const rendered =
          result.value === undefined ? "undefined" : JSON.stringify(result.value);
        return {
          content: [text(rendered)],
          details: { ok: true, output: result.output, nestedCalls },
        };
      }
      const { kind, message } = result.error;
      const summary =
        kind === "script"
          ? `Script failed: ${result.error.stack ?? message}`
          : `Script ${kind}: ${message}`;
      return {
        content: [text(summary)],
        details: { ok: false, error: { kind, message }, output: result.output, nestedCalls },
        isError: true,
      };
    },
  };
}
