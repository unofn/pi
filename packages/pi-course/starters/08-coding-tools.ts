import {
  objectSchema,
  optionalPositiveInteger,
  stringValue,
  ToolRegistry,
  type Schema,
  type Tool,
} from "./tool.js";

export type ContainmentMode = "workspace" | "unrestricted";

export interface CodingToolsOptions {
  cwd: string;
  containment: ContainmentMode;
  maxReadBytes?: number;
  maxReadLines?: number;
  maxBashOutputBytes?: number;
  bashTimeoutMs?: number;
}

export class MutationQueue {
  async run<T>(
    _key: string,
    _operation: () => Promise<T>,
  ): Promise<T> {
    throw labError("Lab 8.3 修改队列");
  }
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

function labError(lab: string): Error {
  return new Error(`${lab} 尚未实现`);
}

function placeholderTool(
  name: string,
  description: string,
  schema: Schema<unknown>,
  lab: string,
): Tool {
  return {
    name,
    description,
    schema,
    async execute() {
      throw labError(lab);
    },
  };
}

function pathPlaceholderTool(
  options: CodingToolsOptions,
  name: string,
  description: string,
  schema: Schema<unknown>,
  lab: string,
): Tool {
  return {
    name,
    description,
    schema,
    async execute(parameters) {
      const candidate = (
        parameters as { path?: unknown }
      ).path;
      if (typeof candidate !== "string") {
        throw new Error("path 必须是 string");
      }
      // 完成 Lab 8.2 后，越界请求会在后续工具的施工位之前被拒绝。
      await resolvePathForWorkspace(options, candidate);
      throw labError(lab);
    },
  };
}

const readSchema = objectSchema({
  path: stringValue,
  offset: optionalPositiveInteger,
  limit: optionalPositiveInteger,
});

const editSchema: Schema<unknown> = {
  jsonSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      oldText: { type: "string" },
      newText: { type: "string" },
      edits: { type: "array" },
    },
    required: ["path"],
  },
  parse(value) {
    return value;
  },
};

async function resolvePathForWorkspace(
  _options: CodingToolsOptions,
  _candidate: string,
): Promise<string> {
  // Lab 8.2：让 Read、Write、Edit 共用同一条 workspace 路径规则。
  throw labError("Lab 8.2 路径边界");
}

/**
 * 这是工具层的学习脚手架，不是参考实现。
 *
 * 每个工具保留名称、参数表面与返回详情类型。你要按 Lab 8.1–8.5
 * 逐段补上可观察行为；Lab 8.6 再把这些工具接入真实 Agent 循环。
 */
export function createCodingTools(
  options: CodingToolsOptions,
): ToolRegistry {
  const tools = [
    // Lab 8.1：完整编号行、details、字节上限和可恢复的续读位置。
    placeholderTool(
      "read",
      "按行数和字节上限读取 UTF-8 文件",
      readSchema,
      "Lab 8.1 Read",
    ),
    // Lab 8.3：创建父目录、完整覆盖、同路径串行和原子写回。
    pathPlaceholderTool(
      options,
      "write",
      "显式创建或完整覆盖一个 UTF-8 文件",
      objectSchema({ path: stringValue, content: stringValue }),
      "Lab 8.3 Write",
    ),
    // Lab 8.4：先验证整批精确替换，再一次写回。
    pathPlaceholderTool(
      options,
      "edit",
      "按顺序应用一批唯一精确匹配",
      editSchema,
      "Lab 8.4 Edit",
    ),
    // Lab 8.5：固定 cwd、退出码、预取消、输出上限和运行终止。
    placeholderTool(
      "bash",
      "在指定 cwd 启动可取消、有超时和输出上限的子进程",
      objectSchema({ command: stringValue }),
      "Lab 8.5 Bash",
    ),
  ];

  // Lab 8.6：不再新增隐藏算法；用 ScriptedModel 和真实 Agent 循环验收闭环。
  return new ToolRegistry(tools);
}
