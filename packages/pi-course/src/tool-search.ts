import {
  objectSchema,
  optionalPositiveInteger,
  stringValue,
  type Tool,
  type ToolRegistry,
} from "./tool.js";
import { text } from "./types.js";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;

/** 排序器看到的一个工具：名字，以及由 toolSearchDocument 拼出的检索文本。 */
export interface ToolSearchDocument {
  name: string;
  text: string;
}

export interface ToolSearchMatch {
  name: string;
  score: number;
}

export interface ToolSearchDetails {
  /** 本次调用激活的工具。 */
  loaded: string[];
}

const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in",
  "is", "it", "of", "on", "or", "that", "the", "this", "to", "with",
]);

/** 朴素单数化：issues → issue，searches → search。 */
function stem(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) {
    return term.slice(0, -2);
  }
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) {
    return term.slice(0, -1);
  }
  return term;
}

/** 小写词项：在 camelCase 边界与非字母数字处切分，去掉停用词。 */
export function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0 && !STOP_WORDS.has(term))
    .map(stem);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 递归收集 schema 的 description 与属性名。 */
function schemaText(schema: unknown, parts: string[]): void {
  if (!isRecord(schema)) return;
  if (typeof schema.description === "string") parts.push(schema.description);
  if (isRecord(schema.properties)) {
    for (const [name, property] of Object.entries(schema.properties)) {
      parts.push(name);
      schemaText(property, parts);
    }
  }
  schemaText(schema.items, parts);
}

/** 一个工具的检索文本：名字、把 `_` 当空格的名字、描述、schema 的描述与属性名。 */
export function toolSearchDocument(
  tool: Pick<Tool, "name" | "description" | "schema">,
): ToolSearchDocument {
  const parts = [tool.name, tool.name.replaceAll("_", " "), tool.description];
  schemaText(tool.schema.jsonSchema, parts);
  return {
    name: tool.name,
    text: parts.filter((part) => part.trim().length > 0).join(" "),
  };
}

/**
 * 课程版排序：按“查询词项与文档词项的重叠个数”打分（上游用 BM25）。
 * 分数相同保持文档顺序；没有任何重叠的文档不进入结果。
 */
export function rankTools(
  query: string,
  documents: readonly ToolSearchDocument[],
  limit: number,
): ToolSearchMatch[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0 || documents.length === 0 || limit <= 0) {
    return [];
  }
  const matches: ToolSearchMatch[] = [];
  for (const document of documents) {
    const terms = new Set(tokenize(document.text));
    const score = queryTerms.filter((term) => terms.has(term)).length;
    if (score > 0) matches.push({ name: document.name, score });
  }
  return matches
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export interface ToolSearchOptions {
  /** 每次最多激活多少个工具；缺省 8。 */
  limit?: number;
}

/**
 * tool_search 是一个 model-only 工具：对尚未声明的 codemode / deferred 工具
 * 做关键词排序，把命中的工具激活，下一次请求的声明补丁就会把它们交给模型。
 * 描述里刻意不列出可搜索的工具，这样 MCP 服务器连上时它的声明也不会变。
 */
export function createToolSearchTool(
  registry: ToolRegistry,
  options: ToolSearchOptions = {},
): Tool<{ query: string; limit: number | undefined }, ToolSearchDetails> {
  const defaultLimit = options.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
  return {
    name: TOOL_SEARCH_TOOL_NAME,
    description:
      "Search tools that are not loaded yet by keyword and load the matches; they are declared from your next call.",
    schema: objectSchema({
      query: stringValue,
      limit: optionalPositiveInteger,
    }),
    exposure: "model-only",
    async execute({ query, limit }) {
      if (query.trim().length === 0) {
        throw new Error("query 不能为空");
      }
      const candidates = registry.list().filter((tool) => {
        const exposure = tool.exposure ?? "direct";
        return (
          (exposure === "codemode" || exposure === "deferred") &&
          !registry.isActive(tool.name)
        );
      });
      const matches = rankTools(
        query,
        candidates.map(toolSearchDocument),
        limit ?? defaultLimit,
      );
      const loaded = registry.activate(matches.map((match) => match.name));
      const lines = loaded.map((name) => {
        const tool = registry.get(name);
        const summary = tool?.description.trim().split(/\r?\n/)[0] ?? "";
        return `- ${name}: ${summary}`;
      });
      const summary =
        loaded.length === 0
          ? "No matching tools found."
          : `Loaded ${loaded.length} tool${loaded.length === 1 ? "" : "s"}. They are available from your next call:\n${lines.join("\n")}`;
      return { content: [text(summary)], details: { loaded } };
    },
  };
}
