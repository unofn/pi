import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "../src/agent-loop.js";
import { ScriptedModel } from "../src/scripted-model.js";
import { parseSessionEntry } from "../src/session.js";
import {
  executeToolCall,
  objectSchema,
  stringValue,
  ToolRegistry,
  type Tool,
  type ToolExposure,
} from "../src/tool.js";
import {
  createToolSearchTool,
  rankTools,
  tokenize,
  toolSearchDocument,
  TOOL_SEARCH_TOOL_NAME,
} from "../src/tool-search.js";
import {
  assistantMessage,
  currentTools,
  text,
  toolStateChanges,
  userMessage,
  type AgentMessage,
  type SystemMessage,
  type ToolCall,
  type ToolDefinition,
} from "../src/types.js";

interface ProbeTool extends Tool<{ value: string | undefined }> {
  runs: number;
}

function probe(
  name: string,
  exposure?: ToolExposure,
  description = `${name} tool`,
): ProbeTool {
  const tool: ProbeTool = {
    name,
    description,
    schema: objectSchema({
      value: Object.assign(
        (value: unknown) =>
          value === undefined ? undefined : stringValue(value),
        { jsonSchema: { type: "string" }, optional: true },
      ),
    }),
    ...(exposure ? { exposure } : {}),
    runs: 0,
    async execute({ value }) {
      tool.runs += 1;
      return { content: [text(`${name}:${value ?? ""}`)] };
    },
  };
  return tool;
}

function names(tools: readonly { name: string }[]): string[] {
  return tools.map((tool) => tool.name);
}

function call(id: string, name: string, args: unknown = {}): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function definition(
  name: string,
  description = `${name} tool`,
  parameters: Record<string, unknown> = { type: "object" },
): ToolDefinition {
  return { name, description, parameters };
}

/** 声明集合按注册顺序，transcript 重放按首次声明顺序；两者只按名字集合比较。 */
function sortedNames(tools: readonly { name: string }[]): string[] {
  return names(tools).sort();
}

function roles(messages: readonly AgentMessage[]): string[] {
  return messages.map((message) => message.role);
}

function systemMessages(messages: readonly AgentMessage[]): SystemMessage[] {
  return messages.filter(
    (message): message is SystemMessage => message.role === "system",
  );
}

test("Lab 15.1 · 注册表从 exposure 推导声明集合与可调用集合，hidden 两者都不进", () => {
  const registry = new ToolRegistry([
    probe("read"),
    probe("tool_search", "model-only"),
    probe("script_only", "codemode"),
    probe("mcp_issue", "deferred"),
    probe("secret", "hidden"),
  ]);

  assert.deepEqual(names(registry.declared()), ["read", "tool_search"]);
  assert.deepEqual(names(registry.definitions()), ["read", "tool_search"]);
  assert.deepEqual(names(registry.callable()), [
    "read",
    "script_only",
    "mcp_issue",
  ]);
  assert.equal(registry.exposureOf("read"), "direct");
  assert.equal(registry.exposureOf("secret"), "hidden");
  assert.equal(registry.exposureOf("missing"), undefined);
  assert.equal(registry.canCall("secret", "model"), false);
  assert.equal(registry.canCall("secret", "script"), false);
  assert.equal(registry.usesExposure(), true);

  const plain = new ToolRegistry([probe("read"), probe("write")]);
  assert.equal(plain.usesExposure(), false);
  assert.deepEqual(names(plain.definitions()), ["read", "write"]);
  assert.deepEqual(names(plain.callable()), ["read", "write"]);
});

test("Lab 15.1 · activate 只把 codemode / deferred 加入声明集合，忽略未知与 hidden，并保持注册顺序", () => {
  const registry = new ToolRegistry([
    probe("read"),
    probe("script_only", "codemode"),
    probe("mcp_issue", "deferred"),
    probe("secret", "hidden"),
  ]);

  assert.deepEqual(
    registry.activate(["mcp_issue", "secret", "missing", "read"]),
    ["mcp_issue"],
  );
  assert.deepEqual(names(registry.definitions()), ["read", "mcp_issue"]);
  assert.equal(registry.isActive("mcp_issue"), true);
  assert.equal(registry.isActive("secret"), false);
  assert.deepEqual(registry.activate(["mcp_issue"]), []);
  assert.deepEqual(registry.activate(["script_only"]), ["script_only"]);
  assert.deepEqual(names(registry.definitions()), [
    "read",
    "script_only",
    "mcp_issue",
  ]);
  assert.deepEqual(names(registry.callable()), [
    "read",
    "script_only",
    "mcp_issue",
  ]);
});

test("Lab 15.1 · executeToolCall 按调用方作用域拒绝未声明或不可调用的工具，结果仍与 call 配对", async () => {
  const deferred = probe("mcp_issue", "deferred");
  const modelOnly = probe("tool_search", "model-only");
  const hidden = probe("secret", "hidden");
  const registry = new ToolRegistry([probe("read"), deferred, modelOnly, hidden]);

  const fromModel = await executeToolCall(call("c1", "mcp_issue"), registry);
  assert.equal(fromModel.isError, true);
  assert.equal(fromModel.toolCallId, "c1");
  assert.equal(fromModel.toolName, "mcp_issue");
  assert.match(fromModel.content[0]!.text, /工具未声明给模型/);
  assert.equal(deferred.runs, 0);

  const fromScript = await executeToolCall(
    call("c2", "mcp_issue", { value: "x" }),
    registry,
    {},
    "script",
  );
  assert.equal(fromScript.isError, false);
  assert.equal(fromScript.content[0]!.text, "mcp_issue:x");
  assert.equal(deferred.runs, 1);

  const searchFromScript = await executeToolCall(
    call("c3", "tool_search"),
    registry,
    {},
    "script",
  );
  assert.equal(searchFromScript.isError, true);
  assert.match(searchFromScript.content[0]!.text, /不在脚本的可调用集合/);
  assert.equal(modelOnly.runs, 0);

  for (const scope of ["model", "script"] as const) {
    const result = await executeToolCall(call("c4", "secret"), registry, {}, scope);
    assert.equal(result.isError, true);
  }
  assert.equal(hidden.runs, 0);

  const unknown = await executeToolCall(call("c5", "missing"), registry);
  assert.match(unknown.content[0]!.text, /未知工具/);
  registry.activate(["mcp_issue"]);
  const afterActivation = await executeToolCall(
    call("c6", "mcp_issue"),
    registry,
  );
  assert.equal(afterActivation.isError, false);
});

test("Lab 15.2 · currentTools 按顺序重放 toolsAdded / toolsRemoved，先删后加，并与 transcript 不共享引用", () => {
  const alpha = definition("alpha");
  const beta = definition("beta");
  const betaV2 = definition("beta", "beta v2", {
    type: "object",
    properties: { q: { type: "string" } },
  });
  const gamma = definition("gamma");
  const messages: AgentMessage[] = [
    { role: "system", content: "BASE", toolsAdded: [alpha, beta], timestamp: 0 },
    userMessage("hi"),
    {
      role: "system",
      content: "",
      toolsRemoved: [{ name: "alpha" }],
      toolsAdded: [gamma],
      timestamp: 1,
    },
    assistantMessage([text("ok")]),
    {
      role: "system",
      content: "",
      toolsRemoved: [{ name: "beta" }],
      toolsAdded: [betaV2],
      timestamp: 2,
    },
  ];

  const tools = currentTools(messages);
  assert.deepEqual(tools, [gamma, betaV2]);
  (tools[1]!.parameters as Record<string, unknown>).mutated = true;
  assert.equal("mutated" in betaV2.parameters, false);
  assert.deepEqual(currentTools([userMessage("no system")]), []);
  assert.deepEqual(
    currentTools([{ role: "system", content: "prompt only", timestamp: 0 }]),
    [],
  );
});

test("Lab 15.2 · toolStateChanges 把定义变化表示为先删后加，无差异时两边都为空", () => {
  const alpha = definition("alpha");
  const beta = definition("beta");
  const betaV2 = definition("beta", "beta v2");
  const gamma = definition("gamma");

  assert.deepEqual(toolStateChanges([alpha, beta], [betaV2, gamma]), {
    toolsAdded: [betaV2, gamma],
    toolsRemoved: [{ name: "alpha" }, { name: "beta" }],
  });
  assert.deepEqual(toolStateChanges([alpha, beta], [alpha, beta]), {
    toolsAdded: [],
    toolsRemoved: [],
  });
  assert.deepEqual(toolStateChanges([], []), {
    toolsAdded: [],
    toolsRemoved: [],
  });
  // 字段顺序不同但声明相同，不算变化。
  const reordered: ToolDefinition = {
    parameters: { type: "object" },
    description: "alpha tool",
    name: "alpha",
  };
  assert.deepEqual(toolStateChanges([alpha], [reordered]), {
    toolsAdded: [],
    toolsRemoved: [],
  });
});

test("Lab 15.2 · 严格 parser 接受非空 toolsAdded / toolsRemoved，拒绝空列表、未知字段与非 object parameters", () => {
  const entry = {
    id: "s1",
    parentId: null,
    timestamp: 1,
    type: "message",
    message: {
      role: "system",
      content: "",
      toolsAdded: [
        definition("alpha", "alpha tool", {
          type: "object",
          properties: { value: { type: "string" } },
        }),
      ],
      toolsRemoved: [{ name: "beta" }],
      timestamp: 1,
    },
  };
  const parsed = parseSessionEntry(entry);
  assert.deepEqual(parsed, entry);
  assert.notEqual(
    (parsed as { message: SystemMessage }).message.toolsAdded,
    entry.message.toolsAdded,
  );

  const invalid: Record<string, unknown>[] = [
    { toolsAdded: [] },
    { toolsRemoved: [] },
    { toolsAdded: [{ ...definition("alpha"), extra: 1 }] },
    { toolsAdded: [{ name: "alpha", description: "x", parameters: "no" }] },
    { toolsAdded: [{ name: "", description: "x", parameters: {} }] },
    { toolsRemoved: [{}] },
    { toolsRemoved: [{ name: "alpha", description: "x" }] },
  ];
  for (const fields of invalid) {
    assert.throws(
      () =>
        parseSessionEntry({
          ...entry,
          message: { role: "system", content: "", timestamp: 1, ...fields },
        }),
      /toolsAdded|toolsRemoved/,
      `${JSON.stringify(fields)} 不应通过严格 parser`,
    );
  }
});

test("Lab 15.3 · 全 direct 的注册表不写声明补丁：工具往返的 transcript 与第 07 章完全一致", async () => {
  const registry = new ToolRegistry([probe("echo")]);
  const model = new ScriptedModel([
    assistantMessage([call("c1", "echo", { value: "a" })], "toolUse"),
    assistantMessage([text("done")]),
  ]);

  const result = await runAgentLoop({
    model,
    tools: registry,
    context: { messages: [userMessage("go")] },
  });

  assert.equal(result.reason, "stop");
  assert.deepEqual(roles(result.messages), [
    "user",
    "assistant",
    "toolResult",
    "assistant",
  ]);
  assert.deepEqual(names(model.requests[0]!.tools ?? []), ["echo"]);
  assert.deepEqual(currentTools(model.requests[1]!.messages), []);
});

test("Lab 15.3 · 用上 exposure 后，第一次请求前在用户消息之后追加声明补丁，无变化时不再追加；provider 仍从 context.tools 读工具", async () => {
  const registry = new ToolRegistry([
    probe("echo"),
    probe("mcp_issue", "deferred"),
    probe("secret", "hidden"),
  ]);
  const model = new ScriptedModel([
    assistantMessage([call("c1", "echo", { value: "a" })], "toolUse"),
    assistantMessage([text("done")]),
  ]);

  const result = await runAgentLoop({
    model,
    tools: registry,
    context: { messages: [userMessage("go")] },
  });

  assert.deepEqual(roles(result.messages), [
    "user",
    "system",
    "assistant",
    "toolResult",
    "assistant",
  ]);
  const [patch] = systemMessages(result.messages);
  assert.equal(patch!.content, "");
  assert.equal("toolsRemoved" in patch!, false);
  assert.deepEqual(names(patch!.toolsAdded ?? []), ["echo"]);
  for (const request of model.requests) {
    assert.deepEqual(names(request.tools ?? []), ["echo"]);
    assert.deepEqual(currentTools(request.messages), request.tools);
  }
});

test("Lab 15.3 · 恢复的 transcript 声明了注册表里没有的工具时，补丁只写 toolsRemoved；已有前缀不改写", async () => {
  const registry = new ToolRegistry([probe("echo")]);
  const base: SystemMessage = {
    role: "system",
    content: "BASE",
    toolsAdded: [
      definition("echo", "echo tool", registry.definitions()[0]!.parameters),
      definition("ghost"),
    ],
    timestamp: 0,
  };
  const model = new ScriptedModel([assistantMessage([text("done")])]);

  const result = await runAgentLoop({
    model,
    tools: registry,
    context: { messages: [base, userMessage("go")] },
  });

  assert.deepEqual(roles(result.messages), [
    "system",
    "user",
    "system",
    "assistant",
  ]);
  assert.deepEqual(result.messages[0], base);
  const patch = result.messages[2] as SystemMessage;
  assert.equal("toolsAdded" in patch, false);
  assert.deepEqual(patch.toolsRemoved, [{ name: "ghost" }]);
  assert.deepEqual(names(currentTools(result.messages)), ["echo"]);
  assert.deepEqual(names(model.requests[0]!.tools ?? []), ["echo"]);
});

test("Lab 15.4 · 排序只用词项重叠：忽略停用词与大小写，分数相同保持文档顺序，无重叠不入选", () => {
  assert.deepEqual(tokenize("Search Jira issues for the repo"), [
    "search",
    "jira",
    "issue",
    "repo",
  ]);
  // camelCase 在大小写边界切分：GitHub 变成 git、hub；工具名里的 github 仍是一个词项。
  assert.deepEqual(tokenize("listPullRequests from GitHub"), [
    "list",
    "pull",
    "request",
    "git",
    "hub",
  ]);

  const documents = [
    toolSearchDocument(probe("mcp_github_issues", "deferred", "List issues of a GitHub repository")),
    toolSearchDocument(probe("mcp_github_pulls", "deferred", "List pull requests of a GitHub repository")),
    toolSearchDocument(probe("mcp_jira_issues", "deferred", "Search Jira issues")),
    toolSearchDocument(probe("weather", "deferred", "Current weather of a city")),
  ];
  assert.match(documents[0]!.text, /mcp github issues/);

  assert.deepEqual(rankTools("github issues", documents, 8), [
    { name: "mcp_github_issues", score: 2 },
    { name: "mcp_github_pulls", score: 1 },
    { name: "mcp_jira_issues", score: 1 },
  ]);
  assert.deepEqual(rankTools("github issues", documents, 1), [
    { name: "mcp_github_issues", score: 2 },
  ]);
  assert.deepEqual(rankTools("the and of", documents, 8), []);
  assert.deepEqual(rankTools("github", documents, 0), []);
});

test("Lab 15.4 · tool_search 是 model-only 工具：激活命中的 codemode / deferred 工具，忽略已声明与 hidden，返回 loaded 明细", async () => {
  const registry = new ToolRegistry([
    probe("read", "direct", "Read a file"),
    probe("mcp_github_issues", "deferred", "List issues of a GitHub repository"),
    probe("script_helper", "codemode", "Summarize GitHub issues in a script"),
    probe("secret", "hidden", "GitHub issues secret"),
  ]);
  const search = createToolSearchTool(registry);
  registry.register(search);
  assert.equal(search.exposure, "model-only");
  assert.equal(search.name, TOOL_SEARCH_TOOL_NAME);
  assert.deepEqual(names(registry.definitions()), ["read", TOOL_SEARCH_TOOL_NAME]);

  const first = await executeToolCall(
    call("s1", TOOL_SEARCH_TOOL_NAME, { query: "github issues" }),
    registry,
  );
  assert.equal(first.isError, false);
  assert.deepEqual(first.details, {
    loaded: ["mcp_github_issues", "script_helper"],
  });
  assert.match(first.content[0]!.text, /Loaded 2 tools/);
  assert.deepEqual(names(registry.definitions()), [
    "read",
    "mcp_github_issues",
    "script_helper",
    TOOL_SEARCH_TOOL_NAME,
  ]);

  const second = await executeToolCall(
    call("s2", TOOL_SEARCH_TOOL_NAME, { query: "github issues" }),
    registry,
  );
  assert.deepEqual(second.details, { loaded: [] });
  assert.match(second.content[0]!.text, /No matching tools found/);

  const limited = new ToolRegistry([
    probe("a_github", "deferred", "github"),
    probe("b_github", "deferred", "github"),
  ]);
  limited.register(createToolSearchTool(limited, { limit: 1 }));
  const capped = await executeToolCall(
    call("s3", TOOL_SEARCH_TOOL_NAME, { query: "github" }),
    limited,
  );
  assert.deepEqual(capped.details, { loaded: ["a_github"] });

  const empty = await executeToolCall(
    call("s4", TOOL_SEARCH_TOOL_NAME, { query: "   " }),
    registry,
  );
  assert.equal(empty.isError, true);
  assert.match(empty.content[0]!.text, /query 不能为空/);
});

test("Lab 15.4 · 经 loop：搜索前调用 deferred 工具被拒绝，搜索后的下一次请求声明它，模型随后才能调用", async () => {
  const issues = probe("mcp_github_issues", "deferred", "List issues of a GitHub repository");
  const registry = new ToolRegistry([probe("read"), issues]);
  registry.register(createToolSearchTool(registry));
  const model = new ScriptedModel([
    assistantMessage(
      [
        call("c1", "mcp_github_issues", { value: "early" }),
        call("c2", TOOL_SEARCH_TOOL_NAME, { query: "github issues" }),
      ],
      "toolUse",
    ),
    assistantMessage([call("c3", "mcp_github_issues", { value: "late" })], "toolUse"),
    assistantMessage([text("done")]),
  ]);

  const result = await runAgentLoop({
    model,
    tools: registry,
    context: { messages: [userMessage("list my issues")] },
  });

  assert.equal(result.reason, "stop");
  assert.deepEqual(roles(result.messages), [
    "user",
    "system",
    "assistant",
    "toolResult",
    "toolResult",
    "system",
    "assistant",
    "toolResult",
    "assistant",
  ]);
  const early = result.messages[3]!;
  assert.equal(early.role === "toolResult" && early.isError, true);
  assert.equal(issues.runs, 1);
  const late = result.messages[7]!;
  assert.equal(late.role === "toolResult" && late.isError, false);

  const [initial, afterSearch] = systemMessages(result.messages);
  assert.deepEqual(names(initial!.toolsAdded ?? []), ["read", TOOL_SEARCH_TOOL_NAME]);
  assert.deepEqual(names(afterSearch!.toolsAdded ?? []), ["mcp_github_issues"]);
  assert.deepEqual(names(model.requests[0]!.tools ?? []), ["read", TOOL_SEARCH_TOOL_NAME]);
  assert.deepEqual(names(model.requests[1]!.tools ?? []), [
    "read",
    "mcp_github_issues",
    TOOL_SEARCH_TOOL_NAME,
  ]);
  assert.deepEqual(names(model.requests[2]!.tools ?? []), [
    "read",
    "mcp_github_issues",
    TOOL_SEARCH_TOOL_NAME,
  ]);
  for (const request of model.requests) {
    assert.deepEqual(
      sortedNames(currentTools(request.messages)),
      sortedNames(request.tools ?? []),
    );
  }
});
