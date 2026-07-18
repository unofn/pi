import {
  open,
  readdir,
  readFile,
  realpath,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type {
  Tool,
  ToolExecutor,
  ToolRegistry,
} from "./tool.js";
import {
  text,
  type AgentMessage,
  type ToolCall,
  type ToolResultMessage,
  type UserMessage,
} from "./types.js";

interface ResourceBase {
  name: string;
  source: string;
  root: string;
}

export interface InstructionResource extends ResourceBase {
  kind: "instructions";
  body: string;
}

export interface SkillResource extends ResourceBase {
  kind: "skill";
  description: string;
}

export interface TemplateResource extends ResourceBase {
  kind: "template";
  description: string;
  body: string;
}

export type CatalogResource =
  | InstructionResource
  | SkillResource
  | TemplateResource;

export interface ResourceCatalog {
  resources: CatalogResource[];
  instructions: InstructionResource[];
  skills: SkillResource[];
  templates: TemplateResource[];
}

export interface ActivatedSkillFile {
  request: string;
  source: string;
  content: string;
}

export interface ActivatedSkill extends SkillResource {
  body: string;
  resources: ActivatedSkillFile[];
}

export interface ActivateSkillOptions {
  resources?: readonly string[];
}

interface Frontmatter {
  attributes: Record<string, string>;
  body: string;
}

interface Candidate {
  resource: CatalogResource;
  rootOrder: number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
  );
}

function assertWithin(
  root: string,
  candidate: string,
  label: string,
): void {
  if (!within(root, candidate)) {
    throw new Error(`${label} 逃出了声明 root`);
  }
}

function parseFrontmatter(value: string, source: string): Frontmatter {
  const normalized = value.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error(`${source} 缺少 YAML frontmatter`);
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    throw new Error(`${source} 的 YAML frontmatter 没有结束`);
  }
  const attributes: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    if (line.trim() === "") continue;
    const match = line.match(/^([A-Za-z][\w-]*):\s*(.*?)\s*$/);
    if (!match) {
      throw new Error(`${source} 的 frontmatter 行无法解析：${line}`);
    }
    const key = match[1]!;
    const raw = match[2]!;
    attributes[key] = raw.replace(/^(['"])(.*)\1$/, "$2");
  }
  return {
    attributes,
    body: normalized.slice(end + 5).trim(),
  };
}

async function readFrontmatterOnly(file: string): Promise<Frontmatter> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.length,
      0,
    );
    const prefix = buffer.subarray(0, bytesRead).toString("utf8");
    const parsed = parseFrontmatter(prefix, file);
    return { attributes: parsed.attributes, body: "" };
  } finally {
    await handle.close();
  }
}

async function optionalDirectory(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function optionalFile(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function resourceKey(resource: CatalogResource): string {
  return `${resource.kind}:${resource.name}`;
}

function resourceOrder(resource: CatalogResource): number {
  if (resource.kind === "instructions") return 0;
  if (resource.kind === "skill") return 1;
  return 2;
}

function sortResources(
  resources: readonly CatalogResource[],
): CatalogResource[] {
  return [...resources].sort(
    (left, right) =>
      resourceOrder(left) - resourceOrder(right) ||
      compareText(left.name, right.name),
  );
}

async function discoverRoot(
  configuredRoot: string,
  rootOrder: number,
): Promise<Candidate[]> {
  const root = await realpath(configuredRoot);
  const candidates: Candidate[] = [];

  const configuredAgents = path.join(root, "AGENTS.md");
  const agentsBody = await optionalFile(configuredAgents);
  if (agentsBody !== undefined) {
    const source = await realpath(configuredAgents);
    assertWithin(root, source, "AGENTS.md");
    candidates.push({
      rootOrder,
      resource: {
        kind: "instructions",
        name: "AGENTS",
        source,
        root,
        body: agentsBody.trim(),
      },
    });
  }

  const templateDirectory = path.join(root, "templates");
  const templateEntries = (await optionalDirectory(templateDirectory))
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".md"),
    )
    .sort((left, right) => compareText(left.name, right.name));
  for (const entry of templateEntries) {
    const source = await realpath(
      path.join(templateDirectory, entry.name),
    );
    assertWithin(root, source, `template ${entry.name}`);
    const parsed = parseFrontmatter(
      await readFile(source, "utf8"),
      source,
    );
    const name =
      parsed.attributes.name ?? path.basename(entry.name, ".md");
    if (name.trim() === "") {
      throw new Error(`template ${source} 的 name 不能为空`);
    }
    candidates.push({
      rootOrder,
      resource: {
        kind: "template",
        name,
        description: parsed.attributes.description ?? "",
        source,
        root,
        body: parsed.body,
      },
    });
  }

  const skillDirectory = path.join(root, "skills");
  const skillEntries = (await optionalDirectory(skillDirectory))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => compareText(left.name, right.name));
  for (const entry of skillEntries) {
    const skillRoot = await realpath(
      path.join(skillDirectory, entry.name),
    );
    assertWithin(root, skillRoot, `skill ${entry.name}`);
    const source = await realpath(path.join(skillRoot, "SKILL.md"));
    assertWithin(skillRoot, source, `skill ${entry.name} SKILL.md`);
    const metadata = await readFrontmatterOnly(source);
    const name = metadata.attributes.name ?? entry.name;
    if (name.trim() === "") {
      throw new Error(`skill ${source} 的 name 不能为空`);
    }
    candidates.push({
      rootOrder,
      resource: {
        kind: "skill",
        name,
        description: metadata.attributes.description ?? "",
        source,
        root: skillRoot,
      },
    });
  }

  const seen = new Map<string, string>();
  for (const candidate of candidates) {
    const key = resourceKey(candidate.resource);
    const previous = seen.get(key);
    if (previous) {
      throw new Error(
        `同一 resource root 内 ${key} 重复：${previous} 与 ${candidate.resource.source}`,
      );
    }
    seen.set(key, candidate.resource.source);
  }
  return candidates;
}

/**
 * roots 的输入顺序就是 precedence。冲突按 kind+name 判断，先出现的 root
 * 获胜；最终输出按逻辑身份排序，不使用绝对路径决定顺序。
 */
export async function discoverResources(
  roots: readonly string[],
): Promise<ResourceCatalog> {
  const winners = new Map<string, Candidate>();
  for (const [rootOrder, root] of roots.entries()) {
    for (const candidate of await discoverRoot(root, rootOrder)) {
      const key = resourceKey(candidate.resource);
      if (!winners.has(key)) winners.set(key, candidate);
    }
  }
  const resources = sortResources(
    [...winners.values()].map((candidate) => candidate.resource),
  );
  const catalog: ResourceCatalog = {
    resources,
    instructions: resources.filter(
      (resource): resource is InstructionResource =>
        resource.kind === "instructions",
    ),
    skills: resources.filter(
      (resource): resource is SkillResource =>
        resource.kind === "skill",
    ),
    templates: resources.filter(
      (resource): resource is TemplateResource =>
        resource.kind === "template",
    ),
  };
  return structuredClone(catalog);
}

async function resolveInsideSkill(
  root: string,
  request: string,
): Promise<string> {
  if (request.trim() === "" || path.isAbsolute(request)) {
    throw new Error(`skill resource ${request} 逃出了声明 root`);
  }
  const lexical = path.resolve(root, request);
  assertWithin(root, lexical, `skill resource ${request}`);
  const source = await realpath(lexical);
  assertWithin(root, source, `skill resource ${request}`);
  return source;
}

/**
 * discovery 只留下 skill metadata；正文和附加文件都在显式激活时读取。
 */
export async function activateSkill(
  catalog: ResourceCatalog,
  name: string,
  options: ActivateSkillOptions = {},
): Promise<ActivatedSkill> {
  const skill = catalog.skills.find((candidate) => candidate.name === name);
  if (!skill) throw new Error(`skill 不存在：${name}`);

  const source = await realpath(skill.source);
  assertWithin(skill.root, source, `skill ${name}`);
  const parsed = parseFrontmatter(await readFile(source, "utf8"), source);
  const currentName =
    parsed.attributes.name ?? path.basename(skill.root);
  if (currentName !== skill.name) {
    throw new Error(
      `skill ${name} 激活时身份变成了 ${currentName}`,
    );
  }

  const resources: ActivatedSkillFile[] = [];
  const seenRequests = new Set<string>();
  for (const request of options.resources ?? []) {
    if (seenRequests.has(request)) continue;
    seenRequests.add(request);
    const resourceSource = await resolveInsideSkill(skill.root, request);
    resources.push({
      request,
      source: resourceSource,
      content: await readFile(resourceSource, "utf8"),
    });
  }
  return structuredClone({
    ...skill,
    source,
    body: parsed.body,
    resources,
  });
}

const PLACEHOLDER = /{{([A-Za-z_][A-Za-z0-9_]*)}}/g;

export function renderTemplate(
  template: TemplateResource,
  args: Readonly<Record<string, string>>,
): UserMessage {
  const rendered = template.body.replace(
    PLACEHOLDER,
    (_whole, key: string) => {
      if (!Object.prototype.hasOwnProperty.call(args, key)) {
        throw new Error(`template ${template.name} 缺少参数 ${key}`);
      }
      return args[key]!;
    },
  );
  return {
    role: "user",
    content: [text(rendered)],
    timestamp: Date.now(),
  };
}

function linesForActivatedSkill(skill: ActivatedSkill): string[] {
  const lines = [
    `## 已激活 skill：${skill.name}`,
    skill.body,
  ];
  for (const resource of skill.resources) {
    lines.push(
      `### skill 文件：${resource.request}`,
      resource.content,
    );
  }
  return lines;
}

/**
 * 资源文本进入 system message 的具名段落，不与基础 prompt 拼接成一个字符串。
 * 段落按名字替换，所以资源变化只需要一条只含这个段落的 system 补丁。
 */
export const RESOURCE_SECTION = "pi-resources";

/**
 * 只生成资源段落的文本。inactive skill 只暴露 name/description，
 * 正文只来自显式 ActivatedSkill。
 */
export function formatResourceContext(
  catalog: ResourceCatalog,
  activatedSkills: readonly ActivatedSkill[],
): string {
  const lines: string[] = ["# Pi resources"];
  for (const instruction of catalog.instructions) {
    lines.push("## AGENTS instructions", instruction.body);
  }
  if (catalog.skills.length > 0) {
    lines.push(
      "## 可用 skills",
      ...catalog.skills.map(
        (skill) => `- ${skill.name}: ${skill.description}`,
      ),
    );
  }

  const activatedByName = new Map<string, ActivatedSkill>();
  for (const activated of activatedSkills) {
    if (activatedByName.has(activated.name)) {
      throw new Error(`skill 重复激活：${activated.name}`);
    }
    const discovered = catalog.skills.find(
      (skill) => skill.name === activated.name,
    );
    if (!discovered || discovered.source !== activated.source) {
      throw new Error(
        `activated skill 不属于当前 catalog：${activated.name}`,
      );
    }
    activatedByName.set(activated.name, structuredClone(activated));
  }
  for (const skill of [...activatedByName.values()].sort(
    (left, right) => compareText(left.name, right.name),
  )) {
    lines.push(...linesForActivatedSkill(skill));
  }
  return lines.join("\n\n");
}

export type BeforeToolDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string };

export type BeforeToolCallHook = (
  call: Readonly<ToolCall>,
) =>
  | void
  | BeforeToolDecision
  | Promise<void | BeforeToolDecision>;

export type AfterToolResultHook = (
  result: Readonly<ToolResultMessage>,
) => void | Promise<void>;

export interface ExtensionHookMap {
  beforeToolCall: BeforeToolCallHook;
  afterToolResult: AfterToolResultHook;
}

export interface ExtensionContext {
  registerTool<TParameters, TDetails>(
    tool: Tool<TParameters, TDetails>,
  ): void;
  on<TKey extends keyof ExtensionHookMap>(
    hook: TKey,
    listener: ExtensionHookMap[TKey],
  ): void;
}

export interface ExtensionDiagnostic {
  extensionId: string;
  hook: keyof ExtensionHookMap;
  kind: "error" | "timeout";
  message: string;
}

export interface ExtensionHostOptions {
  hookTimeoutMs: number;
  onDiagnostic?(diagnostic: ExtensionDiagnostic): void;
}

export interface ExtensionHost {
  wrapExecutor(coreExecutor: ToolExecutor): ToolExecutor;
}

export interface ExtensionSource {
  id: string;
  path: string;
}

export interface ExtensionModule {
  default(context: ExtensionContext): void | Promise<void>;
}

export interface LoadExtensionOptions {
  isTrusted(
    source: Readonly<ExtensionSource>,
  ): boolean | Promise<boolean>;
  importModule(
    source: Readonly<ExtensionSource>,
  ): Promise<unknown>;
  host: ExtensionHost;
}

export type LoadExtensionResult =
  | { id: string; status: "active" }
  | { id: string; status: "skipped_untrusted" };

interface RegisteredBeforeHook {
  extensionId: string;
  listener: BeforeToolCallHook;
}

interface RegisteredAfterHook {
  extensionId: string;
  listener: AfterToolResultHook;
}

interface StagedTool {
  name: string;
  tool: Tool;
}

interface StagedRegistration {
  context: ExtensionContext;
  commit(): void;
}

class HookTimeoutError extends Error {}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

function frozenClone<T>(value: T): Readonly<T> {
  return deepFreeze(structuredClone(value));
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new HookTimeoutError(`${label} timed out`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function blockedResult(
  call: ToolCall,
  extensionId: string,
  kind: "deny" | "error" | "timeout",
  reason: string,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [
      text(
        `Tool ${call.name} blocked by ${extensionId}: ${reason}`,
      ),
    ],
    details: {
      blockedByExtension: extensionId,
      kind,
      reason,
    },
    isError: true,
    timestamp: Date.now(),
  };
}

class ExtensionHostImpl implements ExtensionHost {
  private readonly beforeHooks: RegisteredBeforeHook[] = [];
  private readonly afterHooks: RegisteredAfterHook[] = [];
  private readonly extensionIds = new Set<string>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly options: ExtensionHostOptions,
  ) {}

  stage(extensionId: string): StagedRegistration {
    if (
      extensionId.trim() === "" ||
      this.extensionIds.has(extensionId)
    ) {
      throw new Error(`extension id 无效或重复：${extensionId}`);
    }
    const tools: StagedTool[] = [];
    const toolNames = new Set<string>();
    const beforeHooks: BeforeToolCallHook[] = [];
    const afterHooks: AfterToolResultHook[] = [];
    let committed = false;

    const context: ExtensionContext = {
      registerTool: <TParameters, TDetails>(
        source: Tool<TParameters, TDetails>,
      ): void => {
        const name = source.name;
        if (name.trim() === "" || toolNames.has(name)) {
          throw new Error(`Tool 已存在：${name}`);
        }
        toolNames.add(name);
        const tool: Tool = {
          name,
          description: source.description,
          schema: source.schema,
          execute: (parameters, toolContext) =>
            source.execute(
              parameters as TParameters,
              toolContext,
            ),
        };
        tools.push({ name, tool });
      },
      on: (hook, listener): void => {
        if (hook === "beforeToolCall") {
          beforeHooks.push(listener as BeforeToolCallHook);
        } else if (hook === "afterToolResult") {
          afterHooks.push(listener as AfterToolResultHook);
        } else {
          throw new Error(`extension hook 不存在：${String(hook)}`);
        }
      },
    };

    return {
      context,
      commit: (): void => {
        if (committed) {
          throw new Error(`extension ${extensionId} 已提交`);
        }
        if (this.extensionIds.has(extensionId)) {
          throw new Error(`extension id 重复：${extensionId}`);
        }
        for (const staged of tools) {
          if (this.registry.get(staged.name)) {
            throw new Error(`Tool 已存在：${staged.name}`);
          }
        }
        for (const staged of tools) {
          this.registry.register(staged.tool);
        }
        this.beforeHooks.push(
          ...beforeHooks.map((listener) => ({
            extensionId,
            listener,
          })),
        );
        this.afterHooks.push(
          ...afterHooks.map((listener) => ({
            extensionId,
            listener,
          })),
        );
        this.extensionIds.add(extensionId);
        committed = true;
      },
    };
  }

  private diagnostic(diagnostic: ExtensionDiagnostic): void {
    try {
      this.options.onDiagnostic?.(structuredClone(diagnostic));
    } catch {
      // 诊断观察者不能改变工具事实。
    }
  }

  private async before(
    call: ToolCall,
  ): Promise<ToolResultMessage | undefined> {
    for (const hook of this.beforeHooks) {
      let decision: void | BeforeToolDecision;
      try {
        decision = await withTimeout(
          Promise.resolve().then(() =>
            hook.listener(frozenClone(call))
          ),
          this.options.hookTimeoutMs,
          `beforeToolCall:${hook.extensionId}`,
        );
        if (
          decision !== undefined &&
          decision.decision !== "allow" &&
          decision.decision !== "deny"
        ) {
          throw new Error("beforeToolCall 返回了未知 decision");
        }
      } catch (error) {
        const timeout = error instanceof HookTimeoutError;
        const message = errorMessage(error);
        this.diagnostic({
          extensionId: hook.extensionId,
          hook: "beforeToolCall",
          kind: timeout ? "timeout" : "error",
          message,
        });
        return blockedResult(
          call,
          hook.extensionId,
          timeout ? "timeout" : "error",
          message,
        );
      }
      if (decision?.decision === "deny") {
        return blockedResult(
          call,
          hook.extensionId,
          "deny",
          decision.reason,
        );
      }
    }
    return undefined;
  }

  private async after(result: ToolResultMessage): Promise<void> {
    for (const hook of this.afterHooks) {
      try {
        await withTimeout(
          Promise.resolve().then(() =>
            hook.listener(frozenClone(result))
          ),
          this.options.hookTimeoutMs,
          `afterToolResult:${hook.extensionId}`,
        );
      } catch (error) {
        this.diagnostic({
          extensionId: hook.extensionId,
          hook: "afterToolResult",
          kind: error instanceof HookTimeoutError ? "timeout" : "error",
          message: errorMessage(error),
        });
      }
    }
  }

  wrapExecutor(coreExecutor: ToolExecutor): ToolExecutor {
    return async (sourceCall, context = {}) => {
      const call = structuredClone(sourceCall);
      const blocked = await this.before(call);
      if (blocked) return structuredClone(blocked);

      const coreResult = structuredClone(
        await coreExecutor(structuredClone(call), context),
      );
      await this.after(coreResult);
      return structuredClone(coreResult);
    };
  }
}

export function createExtensionHost(
  registry: ToolRegistry,
  options: ExtensionHostOptions,
): ExtensionHost {
  if (
    !Number.isInteger(options.hookTimeoutMs) ||
    options.hookTimeoutMs < 1
  ) {
    throw new Error("hookTimeoutMs 必须是正整数");
  }
  return new ExtensionHostImpl(registry, options);
}

function hostImplementation(host: ExtensionHost): ExtensionHostImpl {
  if (!(host instanceof ExtensionHostImpl)) {
    throw new Error("host 不是 createExtensionHost 的结果");
  }
  return host;
}

/**
 * trust gate 先于 import。factory 只接触 staging context；成功返回后才把
 * tools/hooks 一次提交到 host。
 */
export async function loadExtension(
  source: ExtensionSource,
  options: LoadExtensionOptions,
): Promise<LoadExtensionResult> {
  if (source.id.trim() === "" || source.path.trim() === "") {
    throw new Error("extension source 缺少 id 或 path");
  }
  const trusted = await options.isTrusted(frozenClone(source));
  if (!trusted) {
    return structuredClone({
      id: source.id,
      status: "skipped_untrusted" as const,
    });
  }

  const imported = await options.importModule(frozenClone(source));
  if (
    imported === null ||
    typeof imported !== "object" ||
    !("default" in imported) ||
    typeof imported.default !== "function"
  ) {
    throw new Error(`extension ${source.id} 缺少 default factory`);
  }
  const factory = imported.default as ExtensionModule["default"];
  const staged = hostImplementation(options.host).stage(source.id);
  await factory(staged.context);
  staged.commit();
  return structuredClone({
    id: source.id,
    status: "active" as const,
  });
}
