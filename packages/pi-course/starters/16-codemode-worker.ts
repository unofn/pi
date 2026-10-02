/**
 * 这是 Chapter 16 的学习脚手架，不是参考实现：辅助函数已经给出，VM 的创建、
 * 桥接与脚本求值留作 Lab 16.1。
 *
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
} from "quickjs-wasi";
import {
  isHostToWorkerMessage,
  PRELUDE_SOURCE,
  type CodemodeWorkerData,
  type WorkerToHostMessage,
} from "./codemode-protocol.js";

function labError(lab: string): Error {
  return new Error(`${lab} 尚未实现`);
}

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

/**
 * Lab 16.1：
 * 1. `QuickJS.create({ wasm, memoryLimit, maxStackSize: MAX_STACK_SIZE, interruptHandler, wasi })`，
 *    interruptHandler 轮询 `data.interrupt` 里的 Int32；
 * 2. 用 `vm.newFunction("bridge", ...)` 把 prelude 的 call / output / done 转成 post()；
 * 3. 求值 PRELUDE_SOURCE 得到 { settle, run, stalled }，监听 parentPort 的 result 消息调用 settle，
 *    每次 settle 之后都执行一次第 5 步的 drain（否则等待工具结果的脚本永远不会继续）；
 * 4. 把脚本包成 `(async (tools, console) => {<code>\n})`，解析失败按 JSException 报 done:false；
 * 5. drain = executePendingJobs 后调用 stalled()：run 之后执行一次，每次 settle 之后再执行一次。
 */
async function main(_data: CodemodeWorkerData): Promise<void> {
  void QuickJS;
  void MAX_STACK_SIZE;
  void JSException;
  void PRELUDE_SOURCE;
  void isHostToWorkerMessage;
  void discardOutput;
  void describeException;
  throw labError("Lab 16.1 codemode worker");
}

if (parentPort) {
  main(workerData as CodemodeWorkerData).catch(crash);
}
