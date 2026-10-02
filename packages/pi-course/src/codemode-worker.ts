/**
 * worker 线程入口。一个 worker 在一个全新的 QuickJS VM（独立 wasm 实例）里跑
 * 一段脚本，把工具调用与输出转给宿主，再报告结果。脚本结束、超时或被取消时，
 * 宿主 terminate 这个 worker；worker 存在的意义是让自旋的脚本永远堵不住宿主线程。
 *
 * import 这个模块就会启动 worker；宿主用编译产物的 URL
 * `new URL("./codemode-worker.js", import.meta.url)` 创建它。
 */
import { parentPort, workerData } from "node:worker_threads";
import {
  JSException,
  MAX_STACK_SIZE,
  QuickJS,
  type JSValueHandle,
} from "quickjs-wasi";
import {
  isHostToWorkerMessage,
  PRELUDE_SOURCE,
  type CodemodeWorkerData,
  type WorkerToHostMessage,
} from "./codemode-protocol.js";

function post(message: WorkerToHostMessage): void {
  parentPort?.postMessage(message);
}

function crash(error: unknown): void {
  post({
    type: "crash",
    message:
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
}

/**
 * QuickJS 把引擎诊断写到 fd 1 / 2，缺省 shim 会转发到宿主的 stdout / stderr。
 * 那是宿主应用的输出，这里丢弃；按“全部写完”汇报，libc 才不会重试。
 */
function discardOutput(memory: { readonly buffer: ArrayBufferLike }) {
  return {
    fd_write(
      _fd: number,
      iovsPtr: number,
      iovsLen: number,
      nwrittenPtr: number,
    ): number {
      const view = new DataView(memory.buffer);
      let written = 0;
      for (let index = 0; index < iovsLen; index += 1) {
        written += view.getUint32(iovsPtr + index * 8 + 4, true);
      }
      view.setUint32(nwrittenPtr, written, true);
      return 0;
    },
  };
}

function describeException(error: JSException): string {
  const head = error.message ? `${error.name}: ${error.message}` : error.name;
  const stack = error.stack?.trimEnd();
  return JSON.stringify({
    name: error.name,
    message: error.message,
    stack: stack ? `${head}\n${stack}` : head,
  });
}

async function main(data: CodemodeWorkerData): Promise<void> {
  const interrupt = new Int32Array(data.interrupt);
  const vm = await QuickJS.create({
    wasm: data.wasm,
    memoryLimit: data.memoryLimitBytes,
    // 没有栈保护时，深递归会让 wasm 栈溢出并 trap，而不是抛出可捕获的 RangeError。
    maxStackSize: MAX_STACK_SIZE,
    interruptHandler: () => Atomics.load(interrupt, 0) !== 0,
    wasi: discardOutput,
  });

  // prelude 只用原始值调用 bridge。
  const bridge = vm.newFunction("bridge", (kind, a, b, c) => {
    switch (kind.toString()) {
      case "call":
        post({
          type: "call",
          id: a.toNumber(),
          name: b.toString(),
          args: c === undefined || c.isUndefined ? undefined : c.toString(),
        });
        break;
      case "output":
        post({ type: "output", text: a.toString() });
        break;
      case "done":
        if (a.toBoolean()) {
          post({
            type: "done",
            ok: true,
            value: b === undefined || b.isUndefined ? undefined : b.toString(),
          });
        } else {
          post({ type: "done", ok: false, error: b.toString() });
        }
        break;
    }
    return vm.undefined;
  });

  // VM 活到宿主 terminate 为止，这些 handle 不需要 dispose。
  const api = vm.withScope((scope) =>
    scope.escape(
      vm.callFunction(
        vm.evalCode(PRELUDE_SOURCE, "codemode-prelude.js"),
        vm.undefined,
        bridge,
        vm.newString(JSON.stringify(data.tools)),
      ),
    ),
  );
  const settle = api.getProp("settle");
  const run = api.getProp("run");
  const stalled = api.getProp("stalled");
  /** 先跑完排队的 job，再检查脚本是否在等一个永远不会结算的 promise。 */
  const drain = () => {
    vm.executePendingJobs();
    vm.callFunction(stalled, api).dispose();
  };

  parentPort?.on("message", (message: unknown) => {
    if (!isHostToWorkerMessage(message)) return;
    try {
      vm.withScope(() => {
        vm.callFunction(
          settle,
          api,
          vm.newNumber(message.id),
          message.ok ? vm.true : vm.false,
          message.payload === undefined
            ? vm.undefined
            : vm.newString(message.payload),
        );
      });
      drain();
    } catch (error) {
      crash(error);
    }
  });

  // 前缀与脚本共享第一行，这样报告的行号就是脚本原本的行号。
  let fn: JSValueHandle;
  try {
    fn = vm.evalCode(
      `(async (tools, console) => {${data.code}\n})`,
      "codemode.js",
    );
  } catch (error) {
    if (!(error instanceof JSException)) throw error;
    post({ type: "done", ok: false, error: describeException(error) });
    return;
  }
  vm.callFunction(run, api, fn).dispose();
  fn.dispose();
  drain();
}

if (parentPort) {
  main(workerData as CodemodeWorkerData).catch(crash);
}
