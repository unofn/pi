/**
 * 这是 Chapter 16 的学习脚手架：消息协议与 prelude 是给定的，和参考实现相同。
 * 本章要动手的是 worker（Lab 16.1）、宿主的 Execution 与嵌套桥（Lab 16.1–16.3）
 * 以及 codemode 工具（Lab 16.4）。
 *
 * 宿主（主线程）与 worker 之间的消息。工具参数、结果与返回值都以 JSON 字符串
 * 跨线程：worker 只把字符串送进、拿出 QuickJS VM，自己从不构造结构化值。
 */

export interface CodemodeWorkerData {
  /** 一段 async function body：允许 return 与顶层 await。 */
  code: string;
  /** 脚本可见的工具：`tools.<name>(args)`。 */
  tools: { name: string; description: string }[];
  /** 已编译的 quickjs.wasm；structured clone 让 worker 共享编译结果。 */
  wasm: WebAssembly.Module;
  memoryLimitBytes: number | undefined;
  /**
   * 一个 Int32：宿主在 terminate 之前置为非零，VM 的 interrupt 回调轮询它。
   * 正在 wasm 里自旋的线程也能被打断。
   */
  interrupt: SharedArrayBuffer;
}

/** 脚本抛出的错误，JSON 编码的 `{ name?, message, stack? }`。 */
export type ScriptErrorJson = string;

export type WorkerToHostMessage =
  | { type: "call"; id: number; name: string; args: string | undefined }
  | { type: "output"; text: string }
  | { type: "done"; ok: true; value: string | undefined }
  | { type: "done"; ok: false; error: ScriptErrorJson }
  /** VM 在脚本控制之外失败，例如 wasm trap。 */
  | { type: "crash"; message: string };

/** `payload` 在 ok 时是结果 JSON，否则是错误信息。 */
export interface HostToWorkerMessage {
  type: "result";
  id: number;
  ok: boolean;
  payload: string | undefined;
}

export function isWorkerToHostMessage(
  value: unknown,
): value is WorkerToHostMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === "call" || type === "output" || type === "done" || type === "crash"
  );
}

export function isHostToWorkerMessage(
  value: unknown,
): value is HostToWorkerMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "result"
  );
}

/**
 * 在脚本之前于 QuickJS VM 内求值的 JavaScript。VM 是独立的 wasm 实例，所以这里
 * 不是在守 realm 边界；prelude 把宿主桥关在闭包里，脚本拿不到它，再在其上搭出
 * `tools`、`ALL_TOOLS` 与 `console`。
 *
 * 求值结果是函数 `(bridge, toolsJson) => { settle, run, stalled }`：
 * - `bridge("call", id, name, argsJson)`、`bridge("output", text)`、
 *   `bridge("done", ok, valueJsonOrErrorJson)`；
 * - `settle(id, ok, payload)` 结算一次工具调用；
 * - `run(fn)` 运行脚本函数；
 * - `stalled()`：没有任何工具调用在途而脚本仍未结束时，报告它永远不会被唤醒
 *   （VM 里没有计时器与 I/O）。
 *
 * 读取不存在的 `tools.<name>` 会立刻抛出带近似名的 TypeError，而不是稍后的
 * “not a function”（上游 1.0 的 Proxy 行为）。
 */
/**
 * 一次执行最多保留的输出：`console.*` 文本的总字符数与调用次数。宿主要把全部输出
 * 留到脚本结束，没有上限时循环打印会把宿主内存耗尽；次数上限覆盖打印空串的循环。
 * 与上游 v1.0.0 之后的修复（packages/codemode/src/runtime/prelude-source.ts，提交 319fecb89）同值。
 */
export const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;
export const MAX_OUTPUT_ITEMS = 100_000;

export const PRELUDE_SOURCE: string = `(function (bridge, toolsJson) {
  "use strict";
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const promiseThen = Promise.prototype.then;
  const ErrorCtor = Error;
  const TypeErrorCtor = TypeError;
  const RangeErrorCtor = RangeError;
  const pending = new Map();
  let nextId = 1;
  let finished = false;

  function done(ok, payload) {
    if (finished) return;
    finished = true;
    bridge("done", ok, payload);
  }

  function serialize(value) {
    return value === undefined ? undefined : stringify(value);
  }

  function errorText(error) {
    const head = error.message ? error.name + ": " + error.message : String(error.name);
    const frames =
      typeof error.stack === "string"
        ? error.stack.split("\\n").filter((line) => line.trim() && !line.includes("codemode-prelude.js"))
        : [];
    return [head, ...frames].join("\\n");
  }

  function format(value) {
    if (typeof value === "string") return value;
    if (value instanceof ErrorCtor) return errorText(value);
    try {
      const json = stringify(value);
      return json === undefined ? String(value) : json;
    } catch {
      return String(value);
    }
  }

  function describeError(error) {
    if (error instanceof ErrorCtor) {
      return stringify({ name: error.name, message: error.message, stack: errorText(error) });
    }
    return stringify({ message: format(error) });
  }

  function caller(name) {
    return (...args) =>
      new Promise((resolve, reject) => {
        let json;
        try {
          json = serialize(args[0]);
        } catch (error) {
          reject(error);
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        bridge("call", id, name, json);
      });
  }

  const tools = Object.create(null);
  const allTools = [];
  for (const { name, description } of parse(toolsJson)) {
    if (name in tools) continue;
    tools[name] = caller(name);
    allTools.push(Object.freeze({ name, description }));
  }
  Object.freeze(tools);
  Object.freeze(allTools);

  const comparable = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const names = allTools.map((tool) => tool.name);
  const toolsProxy = new Proxy(tools, {
    get(object, property, receiver) {
      if (
        typeof property !== "string" ||
        property in object ||
        property in Object.prototype ||
        property === "then" ||
        property === "toJSON"
      ) {
        return Reflect.get(object, property, receiver);
      }
      const wanted = comparable(property);
      const exact = names.filter((name) => comparable(name) === wanted);
      const close =
        exact.length > 0
          ? exact
          : names.filter((name) => wanted && (comparable(name).includes(wanted) || wanted.includes(comparable(name))));
      let message = "tools." + property + " does not exist.";
      if (close.length > 0) message += " Did you mean " + close.slice(0, 5).map((name) => "tools." + name).join(", ") + "?";
      else if (names.length <= 20) message += " Available: " + names.join(", ") + ".";
      message += " ALL_TOOLS lists every tool.";
      throw new TypeErrorCtor(message);
    },
  });

  let outputChars = 0;
  let outputItems = 0;

  // 超过输出上限时脚本失败：先由 done() 报告错误，脚本即使 catch 住也不能继续输出。
  function output(text) {
    if (finished) return;
    outputChars += text.length;
    outputItems += 1;
    if (outputChars > ${MAX_OUTPUT_CHARS} || outputItems > ${MAX_OUTPUT_ITEMS}) {
      const error = new RangeErrorCtor(
        "script output exceeded the limit of ${MAX_OUTPUT_CHARS} characters or ${MAX_OUTPUT_ITEMS} console calls. " +
          "Print a summary instead.",
      );
      done(false, describeError(error));
      throw error;
    }
    bridge("output", text);
  }

  const console = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    console[level] = (...args) => output(args.map(format).join(" "));
  }
  Object.freeze(console);

  Object.defineProperty(globalThis, "tools", { value: toolsProxy, enumerable: true });
  Object.defineProperty(globalThis, "ALL_TOOLS", { value: allTools, enumerable: true });
  Object.defineProperty(globalThis, "console", { value: console, enumerable: true });

  return {
    settle(id, ok, payload) {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (!ok) {
        entry.reject(new ErrorCtor(payload));
        return;
      }
      let value;
      try {
        value = payload === undefined ? undefined : parse(payload);
      } catch (error) {
        entry.reject(error);
        return;
      }
      entry.resolve(value);
    },
    run(fn) {
      let promise;
      try {
        promise = fn(toolsProxy, console);
      } catch (error) {
        done(false, describeError(error));
        return;
      }
      promiseThen.call(
        promise,
        (value) => {
          let json;
          try {
            json = serialize(value);
          } catch (error) {
            done(false, describeError(error));
            return;
          }
          done(true, json);
        },
        (error) => {
          done(false, describeError(error));
        },
      );
    },
    stalled() {
      if (finished || pending.size > 0) return false;
      done(
        false,
        stringify({
          name: "Error",
          message:
            "The script is waiting on a promise that can never settle: no tool call is pending, and timers do not exist here.",
        }),
      );
      return true;
    },
  };
})`;
