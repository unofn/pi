import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildContext } from "../src/context.js";
import {
  activateSkill,
  createExtensionHost,
  discoverResources,
  formatResourceContext,
  loadExtension,
  renderTemplate,
  RESOURCE_SECTION,
  type ExtensionContext,
  type ExtensionDiagnostic,
  type ExtensionHost,
  type ExtensionModule,
} from "../src/resources.js";
import type { SessionEntry } from "../src/session.js";
import {
  objectSchema,
  ToolRegistry,
  type Tool,
  type ToolExecutor,
} from "../src/tool.js";
import {
  currentSystemPrompt,
  text,
  textOf,
  userMessage,
  type SystemMessage,
  type ToolCall,
  type ToolResultMessage,
} from "../src/types.js";

async function writeSkill(
  root: string,
  directory: string,
  options: {
    name: string;
    description: string;
    body: string;
  },
): Promise<string> {
  const skillRoot = path.join(root, "skills", directory);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    path.join(skillRoot, "SKILL.md"),
    [
      "---",
      `name: ${options.name}`,
      `description: ${options.description}`,
      "---",
      options.body,
    ].join("\n"),
    "utf8",
  );
  return skillRoot;
}

async function writeTemplate(
  root: string,
  file: string,
  options: {
    name: string;
    description: string;
    body: string;
  },
): Promise<void> {
  const directory = path.join(root, "templates");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, file),
    [
      "---",
      `name: ${options.name}`,
      `description: ${options.description}`,
      "---",
      options.body,
    ].join("\n"),
    "utf8",
  );
}

function emptyTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    schema: objectSchema({}),
    async execute() {
      return { content: [text(`ran:${name}`)] };
    },
  };
}

function toolCall(
  id: string,
  name = "core",
  argumentsValue: unknown = {},
): ToolCall {
  return {
    type: "toolCall",
    id,
    name,
    arguments: argumentsValue,
  };
}

function toolResult(
  call: ToolCall,
  value = "core result",
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [text(value)],
    details: { source: "core" },
    isError: false,
    timestamp: 1,
  };
}

async function loadInline(
  host: ExtensionHost,
  id: string,
  factory: ExtensionModule["default"],
): Promise<void> {
  const loaded = await loadExtension(
    { id, path: `/virtual/${id}.js` },
    {
      isTrusted: () => true,
      async importModule() {
        return { default: factory };
      },
      host,
    },
  );
  assert.equal(loaded.status, "active");
}

test("Lab 12.1 · roots 输入顺序决定 kind+name 冲突的 precedence", async (t) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "pi-resource-precedence-"),
  );
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const project = path.join(temporary, "project");
  const user = path.join(temporary, "user");
  await mkdir(project, { recursive: true });
  await mkdir(user, { recursive: true });
  await writeFile(path.join(project, "AGENTS.md"), "PROJECT RULE");
  await writeFile(path.join(user, "AGENTS.md"), "USER RULE");
  await writeSkill(project, "review-project", {
    name: "review",
    description: "project review",
    body: "PROJECT SKILL BODY",
  });
  await writeSkill(user, "review-user", {
    name: "review",
    description: "user review",
    body: "USER SKILL BODY",
  });
  await writeTemplate(project, "project.md", {
    name: "prompt",
    description: "project prompt",
    body: "PROJECT {{target}}",
  });
  await writeTemplate(user, "user.md", {
    name: "prompt",
    description: "user prompt",
    body: "USER {{target}}",
  });

  const projectFirst = await discoverResources([project, user]);
  assert.deepEqual(
    projectFirst.resources.map(
      (resource) => `${resource.kind}:${resource.name}`,
    ),
    ["instructions:AGENTS", "skill:review", "template:prompt"],
  );
  assert.equal(projectFirst.instructions[0]?.body, "PROJECT RULE");
  assert.equal(
    projectFirst.skills[0]?.description,
    "project review",
  );
  assert.equal(
    projectFirst.templates[0]?.body,
    "PROJECT {{target}}",
  );

  const userFirst = await discoverResources([user, project]);
  assert.equal(userFirst.instructions[0]?.body, "USER RULE");
  assert.equal(userFirst.skills[0]?.description, "user review");
  assert.equal(userFirst.templates[0]?.body, "USER {{target}}");
});

test("Lab 12.1 · catalog 按逻辑身份稳定输出，inactive skill 不含正文", async (t) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "pi-resource-stable-"),
  );
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "root-with-random-name");
  await mkdir(root, { recursive: true });
  await writeSkill(root, "z-physical-directory", {
    name: "alpha",
    description: "first logical skill",
    body: "SECRET_ALPHA_BODY",
  });
  await writeSkill(root, "a-physical-directory", {
    name: "zeta",
    description: "last logical skill",
    body: "SECRET_ZETA_BODY",
  });
  await writeTemplate(root, "z-file.md", {
    name: "aardvark",
    description: "first logical template",
    body: "AARDVARK",
  });
  await writeTemplate(root, "a-file.md", {
    name: "zebra",
    description: "last logical template",
    body: "ZEBRA",
  });

  const first = await discoverResources([root]);
  const second = await discoverResources([root]);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.resources.map(
      (resource) => `${resource.kind}:${resource.name}`,
    ),
    [
      "skill:alpha",
      "skill:zeta",
      "template:aardvark",
      "template:zebra",
    ],
  );
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /SECRET_ALPHA_BODY/);
  assert.doesNotMatch(serialized, /SECRET_ZETA_BODY/);
  assert.equal(
    Object.prototype.hasOwnProperty.call(first.skills[0], "body"),
    false,
  );
});

test("Lab 12.2 · activateSkill 才读取正文，并返回 canonical source", async (t) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "pi-resource-activate-"),
  );
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "root");
  const skillRoot = await writeSkill(root, "review", {
    name: "review",
    description: "inspect changes",
    body: "READ THE DIFF FIRST",
  });
  const catalog = await discoverResources([root]);
  const before = structuredClone(catalog);
  assert.doesNotMatch(JSON.stringify(catalog), /READ THE DIFF FIRST/);

  const activated = await activateSkill(catalog, "review");
  assert.equal(activated.body, "READ THE DIFF FIRST");
  assert.equal(
    activated.source,
    await realpath(path.join(skillRoot, "SKILL.md")),
  );
  assert.equal(activated.root, await realpath(skillRoot));
  assert.deepEqual(activated.resources, []);
  assert.deepEqual(catalog, before);
  activated.body = "mutated activation";
  assert.deepEqual(catalog, before);
});

test("Lab 12.2 · activateSkill 显式读取 root 内文件并返回每个来源", async (t) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "pi-resource-files-"),
  );
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "root");
  const skillRoot = await writeSkill(root, "review", {
    name: "review",
    description: "inspect",
    body: "Read references/checklist.md",
  });
  const references = path.join(skillRoot, "references");
  await mkdir(references, { recursive: true });
  await writeFile(
    path.join(references, "checklist.md"),
    "tests\nsecurity\n",
  );

  const catalog = await discoverResources([root]);
  const activated = await activateSkill(catalog, "review", {
    resources: [
      "references/checklist.md",
      "references/checklist.md",
    ],
  });
  assert.deepEqual(activated.resources, [
    {
      request: "references/checklist.md",
      source: await realpath(
        path.join(references, "checklist.md"),
      ),
      content: "tests\nsecurity\n",
    },
  ]);
});

test("Lab 12.2 · activateSkill 用 realpath 拒绝 traversal、绝对路径和 symlink 逃逸", async (t) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "pi-resource-escape-"),
  );
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "root");
  const skillRoot = await writeSkill(root, "review", {
    name: "review",
    description: "inspect",
    body: "Stay inside root",
  });
  const references = path.join(skillRoot, "references");
  await mkdir(references, { recursive: true });
  await writeFile(path.join(references, "safe.md"), "safe");
  const outside = path.join(temporary, "outside.md");
  await writeFile(outside, "secret");
  await symlink(outside, path.join(references, "escape.md"));
  const catalog = await discoverResources([root]);

  const valid = await activateSkill(catalog, "review", {
    resources: ["references/safe.md"],
  });
  assert.equal(valid.resources[0]?.content, "safe");
  await assert.rejects(
    activateSkill(catalog, "review", {
      resources: ["../../outside.md"],
    }),
    /逃出了声明 root/,
  );
  await assert.rejects(
    activateSkill(catalog, "review", {
      resources: [outside],
    }),
    /逃出了声明 root/,
  );
  await assert.rejects(
    activateSkill(catalog, "review", {
      resources: ["references/escape.md"],
    }),
    /逃出了声明 root/,
  );
});

test("Lab 12.3 · renderTemplate 使用唯一占位协议并返回 UserMessage", async (t) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "pi-resource-template-"),
  );
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "root");
  await writeTemplate(root, "review.md", {
    name: "review",
    description: "review one target",
    body: "Review {{target}}; then test {{target}} for {{owner}}.",
  });
  const catalog = await discoverResources([root]);
  const template = catalog.templates[0]!;

  const message = renderTemplate(template, {
    target: "src/parser.ts",
    owner: "runtime",
    ignored: "extra",
  });
  assert.equal(message.role, "user");
  assert.equal(
    textOf(message),
    "Review src/parser.ts; then test src/parser.ts for runtime.",
  );
  assert.equal(Number.isFinite(message.timestamp), true);
  assert.throws(
    () => renderTemplate(template, { target: "src/parser.ts" }),
    /缺少参数 owner/,
  );
});

test("Lab 12.3 · formatResourceContext 只生成资源段落，经 system message 接入唯一 buildContext", async (t) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "pi-resource-context-"),
  );
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "root");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "FOLLOW PROJECT RULES");
  await writeSkill(root, "active", {
    name: "active",
    description: "active metadata",
    body: "ACTIVE BODY",
  });
  await writeSkill(root, "inactive", {
    name: "inactive",
    description: "inactive metadata",
    body: "INACTIVE SECRET BODY",
  });
  const catalog = await discoverResources([root]);
  const activated = await activateSkill(catalog, "active");

  const resourceText = formatResourceContext(catalog, [activated]);
  assert.match(resourceText, /FOLLOW PROJECT RULES/);
  assert.match(resourceText, /active metadata/);
  assert.match(resourceText, /inactive metadata/);
  assert.match(resourceText, /ACTIVE BODY/);
  assert.doesNotMatch(resourceText, /INACTIVE SECRET BODY/);

  assert.equal(RESOURCE_SECTION, "pi-resources");
  const system: SystemMessage = {
    role: "system",
    content: "BASE PROMPT",
    sections: { [RESOURCE_SECTION]: resourceText },
    timestamp: 0,
  };
  const activePath: SessionEntry[] = [
    {
      id: "system",
      parentId: null,
      timestamp: 0,
      type: "message",
      message: system,
    },
    {
      id: "user",
      parentId: "system",
      timestamp: 1,
      type: "message",
      message: userMessage("continue"),
    },
  ];
  const projection = buildContext(activePath, {
    maxTokens: 20,
    reservedOutput: 2,
    safetyMargin: 1,
    estimateTokens: () => 1,
  });
  assert.deepEqual(projection.messages[0], system);
  assert.equal(projection.tokens.system, 1);
  const prompt = currentSystemPrompt(projection.messages) ?? "";
  assert.ok(
    prompt.indexOf("BASE PROMPT") < prompt.indexOf("# Pi resources"),
    "资源段落排在基础 prompt 之后，作为独立段落而不是拼接字符串",
  );
  assert.doesNotMatch(prompt, /INACTIVE SECRET BODY/);
  assert.deepEqual(projection.keptEntryIds, ["user"]);
});

test("Lab 12.4 · trust gate 严格发生在 import 之前", async () => {
  const registry = new ToolRegistry();
  const host = createExtensionHost(registry, {
    hookTimeoutMs: 50,
  });
  const order: string[] = [];
  const untrusted = await loadExtension(
    { id: "blocked", path: "/virtual/blocked.js" },
    {
      isTrusted() {
        order.push("trust");
        return false;
      },
      async importModule() {
        order.push("import");
        return { default() {} };
      },
      host,
    },
  );
  assert.deepEqual(order, ["trust"]);
  assert.deepEqual(untrusted, {
    id: "blocked",
    status: "skipped_untrusted",
  });
  assert.equal(registry.list().length, 0);

  const trusted = await loadExtension(
    { id: "trusted", path: "/virtual/trusted.js" },
    {
      isTrusted() {
        order.push("trust:trusted");
        return true;
      },
      async importModule() {
        order.push("import:trusted");
        return {
          default(context: ExtensionContext) {
            context.registerTool(emptyTool("extension-tool"));
          },
        };
      },
      host,
    },
  );
  assert.deepEqual(order, [
    "trust",
    "trust:trusted",
    "import:trusted",
  ]);
  assert.equal(trusted.status, "active");
  assert.ok(registry.get("extension-tool"));
});

test("Lab 12.4 · factory 使用 staging registration，失败或重名都零残留", async () => {
  const registry = new ToolRegistry([emptyTool("existing")]);
  const host = createExtensionHost(registry, {
    hookTimeoutMs: 50,
  });
  let leakedHookCalls = 0;
  await assert.rejects(
    loadExtension(
      { id: "factory-fails", path: "/virtual/fails.js" },
      {
        isTrusted: () => true,
        async importModule() {
          return {
            default(context: ExtensionContext) {
              context.registerTool(emptyTool("must-not-leak"));
              context.on("beforeToolCall", () => {
                leakedHookCalls += 1;
              });
              throw new Error("factory exploded");
            },
          };
        },
        host,
      },
    ),
    /factory exploded/,
  );
  assert.equal(registry.get("must-not-leak"), undefined);

  await assert.rejects(
    loadExtension(
      { id: "duplicate-tool", path: "/virtual/duplicate.js" },
      {
        isTrusted: () => true,
        async importModule() {
          return {
            default(context: ExtensionContext) {
              context.registerTool(emptyTool("existing"));
              context.on("beforeToolCall", () => {
                leakedHookCalls += 1;
              });
            },
          };
        },
        host,
      },
    ),
    /Tool 已存在：existing/,
  );
  assert.deepEqual(
    registry.list().map((tool) => tool.name),
    ["existing"],
  );

  const wrapped = host.wrapExecutor(async (call) =>
    toolResult(call)
  );
  await wrapped(toolCall("probe"));
  assert.equal(leakedHookCalls, 0);
});

test("Lab 12.5 · before deny 生成配对 error result，core 不执行", async () => {
  const registry = new ToolRegistry();
  const host = createExtensionHost(registry, {
    hookTimeoutMs: 50,
  });
  let seenCall: Readonly<ToolCall> | undefined;
  await loadInline(host, "deny-policy", (context) => {
    context.on("beforeToolCall", (call) => {
      seenCall = call;
      return {
        decision: "deny",
        reason: "secret path",
      };
    });
  });
  let coreCalls = 0;
  const wrapped = host.wrapExecutor(async (call) => {
    coreCalls += 1;
    return toolResult(call);
  });
  const source = toolCall("denied", "write", { path: ".env" });
  const denied = await wrapped(source);

  assert.equal(coreCalls, 0);
  assert.equal(denied.toolCallId, "denied");
  assert.equal(denied.toolName, "write");
  assert.equal(denied.isError, true);
  assert.deepEqual(denied.details, {
    blockedByExtension: "deny-policy",
    kind: "deny",
    reason: "secret path",
  });
  assert.ok(seenCall);
  assert.equal(Object.isFrozen(seenCall), true);
  assert.equal(Object.isFrozen(seenCall.arguments), true);
});

test("Lab 12.5 · before throw 与 timeout 都 fail-closed，并产生 diagnostic", async () => {
  const thrownDiagnostics: ExtensionDiagnostic[] = [];
  const thrownHost = createExtensionHost(new ToolRegistry(), {
    hookTimeoutMs: 50,
    onDiagnostic(diagnostic) {
      thrownDiagnostics.push(diagnostic);
    },
  });
  await loadInline(thrownHost, "throw-policy", (context) => {
    context.on("beforeToolCall", () => {
      throw new Error("policy crashed");
    });
  });
  let thrownCoreCalls = 0;
  const thrown = await thrownHost.wrapExecutor(async (call) => {
    thrownCoreCalls += 1;
    return toolResult(call);
  })(toolCall("throw-call"));
  assert.equal(thrownCoreCalls, 0);
  assert.equal(thrown.toolCallId, "throw-call");
  assert.equal(thrown.isError, true);
  assert.deepEqual(thrownDiagnostics, [
    {
      extensionId: "throw-policy",
      hook: "beforeToolCall",
      kind: "error",
      message: "policy crashed",
    },
  ]);

  const timeoutDiagnostics: ExtensionDiagnostic[] = [];
  const timeoutHost = createExtensionHost(new ToolRegistry(), {
    hookTimeoutMs: 5,
    onDiagnostic(diagnostic) {
      timeoutDiagnostics.push(diagnostic);
    },
  });
  await loadInline(timeoutHost, "timeout-policy", (context) => {
    context.on(
      "beforeToolCall",
      () => new Promise<void>(() => {}),
    );
  });
  let timeoutCoreCalls = 0;
  const timedOut = await timeoutHost.wrapExecutor(async (call) => {
    timeoutCoreCalls += 1;
    return toolResult(call);
  })(toolCall("timeout-call"));
  assert.equal(timeoutCoreCalls, 0);
  assert.equal(timedOut.toolCallId, "timeout-call");
  assert.equal(timedOut.isError, true);
  assert.equal(
    (timedOut.details as { kind?: string }).kind,
    "timeout",
  );
  assert.equal(timeoutDiagnostics.length, 1);
  assert.deepEqual(
    {
      extensionId: timeoutDiagnostics[0]?.extensionId,
      hook: timeoutDiagnostics[0]?.hook,
      kind: timeoutDiagnostics[0]?.kind,
    },
    {
      extensionId: "timeout-policy",
      hook: "beforeToolCall",
      kind: "timeout",
    },
  );
});

test("Lab 12.5 · after 对每个 core result 只运行一次，失败不替换结果", async () => {
  const diagnostics: ExtensionDiagnostic[] = [];
  const host = createExtensionHost(new ToolRegistry(), {
    hookTimeoutMs: 5,
    onDiagnostic(diagnostic) {
      diagnostics.push(diagnostic);
    },
  });
  let successfulAfterCalls = 0;
  await loadInline(host, "after-success", (context) => {
    context.on("afterToolResult", () => {
      successfulAfterCalls += 1;
    });
  });
  await loadInline(host, "after-error", (context) => {
    context.on("afterToolResult", () => {
      throw new Error("observer crashed");
    });
  });
  await loadInline(host, "after-timeout", (context) => {
    context.on(
      "afterToolResult",
      () => new Promise<void>(() => {}),
    );
  });

  const call = toolCall("core-call");
  const coreResult = toolResult(call, "already happened");
  let coreCalls = 0;
  const wrapped: ToolExecutor = host.wrapExecutor(async () => {
    coreCalls += 1;
    return coreResult;
  });
  const returned = await wrapped(call);

  assert.equal(coreCalls, 1);
  assert.equal(successfulAfterCalls, 1);
  assert.notEqual(returned, coreResult);
  assert.deepEqual(returned, coreResult);
  assert.equal(returned.isError, false);
  assert.deepEqual(
    diagnostics.map((diagnostic) => ({
      extensionId: diagnostic.extensionId,
      hook: diagnostic.hook,
      kind: diagnostic.kind,
    })),
    [
      {
        extensionId: "after-error",
        hook: "afterToolResult",
        kind: "error",
      },
      {
        extensionId: "after-timeout",
        hook: "afterToolResult",
        kind: "timeout",
      },
    ],
  );

  returned.content[0]!.text = "mutated returned result";
  (returned.details as { source: string }).source = "mutated";
  assert.equal(textOf(coreResult), "already happened");
  assert.deepEqual(coreResult.details, { source: "core" });
});
