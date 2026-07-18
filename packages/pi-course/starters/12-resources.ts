import type {
  Tool,
  ToolExecutor,
  ToolRegistry,
} from "./tool.js";
import type {
  ToolCall,
  ToolResultMessage,
  UserMessage,
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

function labError(lab: string): Error {
  return new Error(`${lab} 尚未实现`);
}

/**
 * 这是 Chapter 12 的学习脚手架，不是参考实现。
 *
 * 公共类型已经固定。resource precedence、按需激活、模板渲染、
 * extension staging 和 hook 隔离分别留给五段实验。
 */
export async function discoverResources(
  _roots: readonly string[],
): Promise<ResourceCatalog> {
  // Lab 12.1：按 root 顺序选出 kind+name winner，并稳定输出 metadata。
  throw labError("Lab 12.1 resource catalog");
}

export async function activateSkill(
  _catalog: ResourceCatalog,
  _name: string,
  _options: ActivateSkillOptions = {},
): Promise<ActivatedSkill> {
  // Lab 12.2：显式激活时才读正文，并用 realpath 守住 skill root。
  throw labError("Lab 12.2 skill activation");
}

export function renderTemplate(
  _template: TemplateResource,
  _args: Readonly<Record<string, string>>,
): UserMessage {
  // Lab 12.3：只支持 {{name}} 占位符，缺少参数时直接报错。
  throw labError("Lab 12.3 resource context");
}

/**
 * 资源文本进入 system message 的具名段落，不与基础 prompt 拼接成一个字符串。
 */
export const RESOURCE_SECTION = "pi-resources";

export function formatResourceContext(
  _catalog: ResourceCatalog,
  _activatedSkills: readonly ActivatedSkill[],
): string {
  // Lab 12.3：生成唯一资源段落文本，不把 inactive skill 正文带入上下文。
  throw labError("Lab 12.3 resource context");
}

export function createExtensionHost(
  _registry: ToolRegistry,
  _options: ExtensionHostOptions,
): ExtensionHost {
  // Lab 12.4：先暂存 tool/hook，factory 成功后再统一提交。
  throw labError("Lab 12.4 extension staging");
}

export async function loadExtension(
  _source: ExtensionSource,
  _options: LoadExtensionOptions,
): Promise<LoadExtensionResult> {
  // Lab 12.4：trust gate 必须发生在 import 之前。
  throw labError("Lab 12.4 trust loader");
}
