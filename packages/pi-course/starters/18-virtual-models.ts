import type {
  AgentRequest,
  PreparedRequest,
  RequestReason,
} from "./agent-loop.js";
import type { Runtime, RuntimeRequestSession } from "./composition.js";
import type { JsonValue, SessionEntry } from "./session.js";
import type {
  AgentMessage,
  AssistantMessage,
  Model,
  ThinkingLevel,
} from "./types.js";

/**
 * 这是 Chapter 18 的学习脚手架，不是参考实现：类型、目录与 selectModel 已经给出；
 * previous 与路由解析（Lab 18.1）、分支上的选择、状态与路由器（Lab 18.3）留空。
 */
function labError(lab: string): Error {
  return new Error(`${lab} 尚未实现`);
}

/* ------------------------------------------------------------------ */
/* Lab 18.1 · 目录与路由：虚拟模型只做选择，物理模型才被派发               */
/* ------------------------------------------------------------------ */

/**
 * 为什么路由这次请求。user / continuation / retry 与 loop 的 RequestReason 同义；
 * direct 是 loop 之外的请求（例如压缩摘要），不读也不写路由状态。
 */
export type ModelRouteReason = RequestReason | "direct";

/** 目录里一个可以真正发请求的模型。 */
export interface PhysicalModel {
  id: string;
  model: Model;
}

export interface ModelRouteRequest<TState = unknown> {
  /** 被选中的虚拟模型。 */
  model: { id: string };
  reason: ModelRouteReason;
  /** messages 里最近一次成功回复所用的物理模型与推理强度；回复的 model 不在目录里时省略。 */
  previous?: { model: PhysicalModel; thinkingLevel?: ThinkingLevel };
  /** retry 时：那条失败回复。 */
  failed?: { model?: PhysicalModel; message: AssistantMessage };
  /** 这个分支上最近一次返回的路由状态；第一次与 direct 请求为 undefined。 */
  state?: TState;
  messages: readonly AgentMessage[];
  signal?: AbortSignal;
}

/** 一次请求用的物理模型与推理强度。state 若与 request.state 不同则记到分支上。 */
export interface ModelRoute<TState = unknown> {
  model: string;
  thinkingLevel?: ThinkingLevel;
  state?: TState;
}

export interface VirtualModel<TState = unknown> {
  id: string;
  route(
    request: ModelRouteRequest<TState>,
  ): ModelRoute<TState> | Promise<ModelRoute<TState>>;
}

/** 同一张目录登记物理与虚拟模型；id 在两者之间唯一。provider 只会拿到物理模型。 */
export class ModelCatalog {
  private readonly physicalModels = new Map<string, PhysicalModel>();
  private readonly virtualModels = new Map<string, VirtualModel>();

  registerPhysical(id: string, model: Model): void {
    this.assertFree(id);
    this.physicalModels.set(id, { id, model });
  }

  registerVirtual<TState>(virtual: VirtualModel<TState>): void {
    this.assertFree(virtual.id);
    this.virtualModels.set(virtual.id, virtual as VirtualModel);
  }

  private assertFree(id: string): void {
    if (id.trim().length === 0) throw new Error("模型 id 不能为空");
    if (this.physicalModels.has(id)) {
      throw new Error(`模型 ${id} 已经是物理模型`);
    }
    if (this.virtualModels.has(id)) {
      throw new Error(`模型 ${id} 已经是虚拟模型`);
    }
  }

  physical(id: string): PhysicalModel | undefined {
    return this.physicalModels.get(id);
  }

  virtual(id: string): VirtualModel | undefined {
    return this.virtualModels.get(id);
  }

  isVirtual(id: string): boolean {
    return this.virtualModels.has(id);
  }

  has(id: string): boolean {
    return this.physicalModels.has(id) || this.virtualModels.has(id);
  }
}

/** 最近一次成功回复。error 与 aborted 的回复（包括路由失败）都跳过。 */
export function findLatestResponse(
  _messages: readonly AgentMessage[],
): AssistantMessage | undefined {
  // Lab 18.1：从后往前找第一条 stopReason 不是 error / aborted 的 assistant。
  throw labError("Lab 18.1 findLatestResponse");
}

export interface ResolvedRoute<TState = unknown> {
  model: PhysicalModel;
  thinkingLevel?: ThinkingLevel;
  state?: TState;
}

export interface ResolveRouteOptions<TState = unknown> {
  reason: ModelRouteReason;
  messages: readonly AgentMessage[];
  failed?: AssistantMessage;
  state?: TState;
  signal?: AbortSignal;
}

/**
 * 问虚拟模型的 route() 本次用哪个物理模型。route 必须返回目录里的物理模型 id：
 * 路由到另一个虚拟模型、未注册的 id、或 route 抛错，都以异常结束——loop 把它
 * 变成一条 error 回复。
 */
export async function resolveRoute<TState>(
  _catalog: ModelCatalog,
  _virtualId: string,
  _options: ResolveRouteOptions<TState>,
): Promise<ResolvedRoute<TState>> {
  // Lab 18.1：未注册报错；组装 ModelRouteRequest（previous 来自 findLatestResponse，failed 的
  // 物理模型可能查不到）；route 的结果必须是目录里的物理模型，否则报错并说明是虚拟还是未知。
  throw labError("Lab 18.1 resolveRoute");
}

/* ------------------------------------------------------------------ */
/* Lab 18.3 · 分支上的选择与状态                                        */
/* ------------------------------------------------------------------ */

/** metadata entry：用户选中的模型 `{ modelId }`。 */
export const MODEL_CHANGE_KEY = "model_change";
/** metadata entry：虚拟模型在这个分支上最近返回的状态 `{ modelId, state }`。 */
export const VIRTUAL_MODEL_STATE_KEY = "virtual_model_state";

function metadataValue(entry: SessionEntry, key: string): Record<string, JsonValue> | undefined {
  if (entry.type !== "metadata" || entry.key !== key) return undefined;
  const value = entry.value;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

/** 分支上最后一条 model_change 决定选中的模型；没有则 undefined。 */
export function branchSelection(
  _branch: readonly SessionEntry[],
): string | undefined {
  // Lab 18.3：从后往前找 key 为 MODEL_CHANGE_KEY 且值为 { modelId: string } 的 metadata。
  void metadataValue;
  throw labError("Lab 18.3 branchSelection");
}

/** 分支上该虚拟模型最近一次记录的状态。 */
export function virtualModelState(
  _branch: readonly SessionEntry[],
  _modelId: string,
): JsonValue | undefined {
  // Lab 18.3：从后往前找 key 为 VIRTUAL_MODEL_STATE_KEY 且 modelId 匹配的 metadata，返回它的 state。
  throw labError("Lab 18.3 virtualModelState");
}

export interface VirtualModelRoutingOptions {
  /** 分支上没有 model_change 时的选择。 */
  defaultModelId: string;
}

export interface VirtualModelRouting {
  /** 给第 13 章 Runtime 的 RuntimeDeps.prepareRequest。 */
  prepareRequest(
    request: AgentRequest,
    session: RuntimeRequestSession,
    signal?: AbortSignal,
  ): Promise<PreparedRequest>;
  /** loop 之外的一次请求：不读也不写路由状态。 */
  routeDirect(
    session: Pick<RuntimeRequestSession, "branch">,
    messages: readonly AgentMessage[],
    signal?: AbortSignal,
  ): Promise<ResolvedRoute>;
}

function sameState(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 选择留在分支上（model_change），派发只影响本次请求：每次请求前读出选中的
 * 模型，物理模型直接用；虚拟模型经 resolveRoute 换成物理模型，新状态只在
 * 变化时作为 virtual_model_state 记到分支上。路由失败 reject，loop 以 error
 * 回复结束本次请求。
 */
export function createVirtualModelRouting(
  _catalog: ModelCatalog,
  _options: VirtualModelRoutingOptions,
): VirtualModelRouting {
  // Lab 18.3：选中的模型 = branchSelection(branch) ?? defaultModelId；物理模型直接返回；
  // 虚拟模型用 virtualModelState 作为 state 调 resolveRoute（direct 不读状态），
  // 新状态与旧状态不同（按 JSON 比较）才 session.record(VIRTUAL_MODEL_STATE_KEY, { modelId, state })。
  void sameState;
  throw labError("Lab 18.3 createVirtualModelRouting");
}

/** 把用户的选择记到分支上：后续每次请求都从它开始路由。 */
export function selectModel(
  runtime: Pick<Runtime, "appendMetadata">,
  catalog: ModelCatalog,
  modelId: string,
): Promise<void> {
  if (!catalog.has(modelId)) {
    return Promise.reject(new Error(`模型 ${modelId} 未注册`));
  }
  if (!runtime.appendMetadata) {
    return Promise.reject(new Error("Runtime 不支持 appendMetadata"));
  }
  return runtime.appendMetadata(MODEL_CHANGE_KEY, { modelId });
}
