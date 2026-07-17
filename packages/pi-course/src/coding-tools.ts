import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  objectSchema,
  optionalPositiveInteger,
  stringValue,
  ToolRegistry,
  type Tool,
  type ToolOutput,
} from "./tool.js";
import { text } from "./types.js";

export type ContainmentMode = "workspace" | "unrestricted";

export interface CodingToolsOptions {
  cwd: string;
  containment: ContainmentMode;
  maxReadBytes?: number;
  maxReadLines?: number;
  maxBashOutputBytes?: number;
  bashTimeoutMs?: number;
}

export interface ReadDetails {
  path: string;
  bytes: number;
  lines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
}

export interface WriteDetails {
  path: string;
  bytes: number;
}

export interface EditDetails {
  path: string;
  oldBytes: number;
  newBytes: number;
  edits: number;
}

export interface BashDetails {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
}

export class MutationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(key, tail);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

const mutations = new MutationQueue();

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function nearestExistingPath(candidate: string): Promise<string> {
  let cursor = candidate;
  while (true) {
    try {
      return await realpath(cursor);
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`无法解析路径祖先：${candidate}`);
      cursor = parent;
    }
  }
}

async function resolvedPath(
  cwd: string,
  candidate: string,
  containment: ContainmentMode,
): Promise<string> {
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, candidate);
  if (
    containment === "workspace" &&
    resolved !== root &&
    !resolved.startsWith(`${root}${path.sep}`)
  ) {
    throw new Error(`路径越过教学 workspace：${candidate}`);
  }
  if (containment === "workspace") {
    const [realRoot, realCandidateOrParent] = await Promise.all([
      realpath(root),
      nearestExistingPath(resolved),
    ]);
    if (!isInside(realRoot, realCandidateOrParent)) {
      throw new Error(`符号链接越过教学 workspace：${candidate}`);
    }
  }
  return resolved;
}

async function atomicWrite(file: string, value: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.pi-tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, value, "utf8");
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function createReadTool(options: Required<CodingToolsOptions>): Tool {
  return {
    name: "read",
    description: "按行数和字节上限读取 UTF-8 文件",
    schema: objectSchema({
      path: stringValue,
      offset: optionalPositiveInteger,
      limit: optionalPositiveInteger,
    }),
    async execute({ path: inputPath, offset, limit }) {
      const file = await resolvedPath(
        options.cwd,
        inputPath,
        options.containment,
      );
      const value = await readFile(file, "utf8");
      const sourceLines = value.split("\n");
      const startIndex = Math.max(0, (offset ?? 1) - 1);
      const requestedLines = Math.min(
        limit ?? options.maxReadLines,
        options.maxReadLines,
      );
      const requestedEndIndex = Math.min(
        sourceLines.length,
        startIndex + requestedLines,
      );

      if (startIndex >= sourceLines.length) {
        throw new Error(
          `offset=${startIndex + 1} 超出文件范围；文件共 ${sourceLines.length} 行`,
        );
      }

      let selected = "";
      let endIndex = startIndex;
      for (
        let candidateEnd = startIndex + 1;
        candidateEnd <= requestedEndIndex;
        candidateEnd += 1
      ) {
        const body = sourceLines
          .slice(startIndex, candidateEnd)
          .map(
            (line, index) =>
              `${String(startIndex + index + 1).padStart(4, " ")}│ ${line}`,
          )
          .join("\n");
        const hasMore = candidateEnd < sourceLines.length;
        const continuation = hasMore
          ? `\n\n[已显示第 ${startIndex + 1}-${candidateEnd} 行，共 ${sourceLines.length} 行；继续读取：offset=${candidateEnd + 1}]`
          : "";
        const candidate = body + continuation;
        if (Buffer.byteLength(candidate) <= options.maxReadBytes) {
          selected = candidate;
          endIndex = candidateEnd;
        }
      }

      if (endIndex === startIndex) {
        throw new Error(
          `maxReadBytes=${options.maxReadBytes} 太小，无法返回从第 ${startIndex + 1} 行开始的完整可续读结果`,
        );
      }
      const truncated = endIndex < sourceLines.length;
      return {
        content: [text(selected)],
        details: {
          path: file,
          bytes: Buffer.byteLength(value),
          lines: sourceLines.length,
          startLine: startIndex + 1,
          endLine: endIndex,
          truncated,
        } satisfies ReadDetails,
      };
    },
  };
}

function createWriteTool(options: Required<CodingToolsOptions>): Tool {
  return {
    name: "write",
    description: "显式创建或完整覆盖一个 UTF-8 文件",
    schema: objectSchema({
      path: stringValue,
      content: stringValue,
    }),
    async execute({ path: inputPath, content }) {
      const file = await resolvedPath(
        options.cwd,
        inputPath,
        options.containment,
      );
      await mutations.run(file, () => atomicWrite(file, content));
      return {
        content: [text(`已写入 ${Buffer.byteLength(content)} bytes`)],
        details: {
          path: file,
          bytes: Buffer.byteLength(content),
        } satisfies WriteDetails,
      };
    },
  };
}

interface ExactEdit {
  oldText: string;
  newText: string;
}

function parseEditParameters(value: unknown): {
  path: string;
  edits: ExactEdit[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("参数必须是 object");
  }
  const input = value as Record<string, unknown>;
  const inputPath = stringValue(input.path);
  const rawEdits = Array.isArray(input.edits)
    ? input.edits
    : [{ oldText: input.oldText, newText: input.newText }];
  if (rawEdits.length === 0) throw new Error("edits 不能为空");
  const edits = rawEdits.map((edit) => {
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) {
      throw new Error("每个 edit 必须是 object");
    }
    const record = edit as Record<string, unknown>;
    return {
      oldText: stringValue(record.oldText),
      newText: stringValue(record.newText),
    };
  });
  return { path: inputPath, edits };
}

function createEditTool(options: Required<CodingToolsOptions>): Tool {
  return {
    name: "edit",
    description: "先验证一批唯一精确匹配，再一次写回文件",
    schema: { parse: parseEditParameters },
    async execute({ path: inputPath, edits }) {
      const file = await resolvedPath(
        options.cwd,
        inputPath,
        options.containment,
      );
      return mutations.run(file, async () => {
        const current = await readFile(file, "utf8");
        let next = current;
        for (const [index, edit] of edits.entries()) {
          if (!edit.oldText) throw new Error(`edits[${index}].oldText 不能为空`);
          const first = next.indexOf(edit.oldText);
          if (first < 0) throw new Error(`edits[${index}] 没有匹配`);
          if (
            next.indexOf(edit.oldText, first + edit.oldText.length) >= 0
          ) {
            throw new Error(
              `edits[${index}] 匹配多次；请提供更精确的上下文`,
            );
          }
          next =
            next.slice(0, first) +
            edit.newText +
            next.slice(first + edit.oldText.length);
        }
        await atomicWrite(file, next);
        return {
          content: [text(`已完成 ${edits.length} 处精确替换`)],
          details: {
            path: file,
            oldBytes: Buffer.byteLength(current),
            newBytes: Buffer.byteLength(next),
            edits: edits.length,
          } satisfies EditDetails,
        };
      });
    },
  };
}

function killProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // 进程已经退出。
    }
  }
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  const prefix: string[] = [];
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    prefix.push(character);
    bytes += characterBytes;
  }
  return prefix.join("");
}

async function runCommand(
  command: string,
  options: Required<CodingToolsOptions>,
  signal?: AbortSignal,
): Promise<ToolOutput<BashDetails>> {
  if (
    options.containment === "workspace" &&
    /(^|[\s;&|])(?:\/|~\/|\.\.\/)/.test(command)
  ) {
    throw new Error("教学 guardrail 不允许命令中显式出现绝对路径或 ../");
  }
  if (signal?.aborted) {
    return {
      content: [text("运行已经取消，因此命令没有启动。")],
      details: {
        command,
        exitCode: null,
        timedOut: false,
        aborted: true,
        truncated: false,
      },
      isError: true,
    };
  }

  const child = spawn(command, {
    cwd: options.cwd,
    shell: true,
    detached: process.platform !== "win32",
    env: process.env,
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  let timedOut = false;
  let aborted = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  let forceKillDone: Promise<void> | undefined;

  const collect = (chunk: Buffer) => {
    if (bytes >= options.maxBashOutputBytes) {
      truncated = true;
      return;
    }
    const remaining = options.maxBashOutputBytes - bytes;
    const accepted = chunk.subarray(0, remaining);
    chunks.push(accepted);
    bytes += accepted.length;
    if (accepted.length < chunk.length) truncated = true;
  };

  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const terminate = () => {
    killProcessTree(child.pid, "SIGTERM");
    forceKillDone ??= new Promise<void>((resolve) => {
      forceKill = setTimeout(() => {
        killProcessTree(child.pid, "SIGKILL");
        resolve();
      }, 100);
    });
  };
  const onAbort = () => {
    aborted = true;
    terminate();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.bashTimeoutMs);

  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (forceKillDone) await forceKillDone;
  } finally {
    clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
    signal?.removeEventListener("abort", onAbort);
  }

  const suffix = truncated ? "\n… [输出已截断]" : "";
  const captured = Buffer.concat(chunks).toString("utf8");
  let output = captured;
  if (truncated) {
    const boundedSuffix = utf8Prefix(
      suffix,
      options.maxBashOutputBytes,
    );
    const contentBudget = Math.max(
      0,
      options.maxBashOutputBytes - Buffer.byteLength(boundedSuffix),
    );
    output = utf8Prefix(captured, contentBudget) + boundedSuffix;
  }
  const isError = exitCode !== 0 || timedOut || aborted;
  return {
    content: [text(output || `(exit ${exitCode ?? "signal"})`)],
    details: {
      command,
      exitCode,
      timedOut,
      aborted,
      truncated,
    },
    isError,
  };
}

function createBashTool(options: Required<CodingToolsOptions>): Tool {
  return {
    name: "bash",
    description: "在指定 cwd 启动可取消、有超时和输出上限的子进程",
    schema: objectSchema({ command: stringValue }),
    execute({ command }, context) {
      return runCommand(command, options, context.signal);
    },
  };
}

/**
 * workspace 模式只是课程里用于防止常见误操作的 guardrail，不是安全 sandbox。
 * 它不能替代操作系统对 shell、符号链接和子进程的隔离；上游 Pi 默认也不提供 cwd jail。
 */
export function createCodingTools(
  input: CodingToolsOptions,
): ToolRegistry {
  const options: Required<CodingToolsOptions> = {
    maxReadBytes: 48_000,
    maxReadLines: 240,
    maxBashOutputBytes: 96_000,
    bashTimeoutMs: 30_000,
    ...input,
    cwd: path.resolve(input.cwd),
  };
  return new ToolRegistry([
    createReadTool(options),
    createWriteTool(options),
    createEditTool(options),
    createBashTool(options),
  ]);
}
