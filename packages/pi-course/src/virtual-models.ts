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
  messages: readonly AgentMessage[],
): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (
      message.role === "assistant" &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted"
    ) {
      return message;
    }
  }
  return undefined;
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
  catalog: ModelCatalog,
  virtualId: string,
  options: ResolveRouteOptions<TState>,
): Promise<ResolvedRoute<TState>> {
  const name = `Virtual model ${virtualId}`;
  const virtual = catalog.virtual(virtualId) as VirtualModel<TState> | undefined;
  if (!virtual) throw new Error(`${name} is not registered.`);
  const latest = findLatestResponse(options.messages);
  const previousModel = latest && catalog.physical(latest.model);
  const failedModel = options.failed && catalog.physical(options.failed.model);
  const route = await virtual.route({
    model: { id: virtualId },
    reason: options.reason,
    ...(previousModel ? { previous: { model: previousModel } } : {}),
    ...(options.failed
      ? { failed: { ...(failedModel ? { model: failedModel } : {}), message: options.failed } }
      : {}),
    ...(options.state === undefined ? {} : { state: options.state }),
    messages: options.messages,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const target = catalog.physical(route.model);
  if (!target) {
    const why = catalog.isVirtual(route.model)
      ? "which is another virtual model"
      : "which is not a physical model";
    throw new Error(`${name} routed to ${route.model}, ${why}.`);
  }
  return {
    model: target,
    ...(route.thinkingLevel === undefined ? {} : { thinkingLevel: route.thinkingLevel }),
    ...(route.state === undefined ? {} : { state: route.state }),
  };
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
  branch: readonly SessionEntry[],
): string | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const value = metadataValue(branch[index]!, MODEL_CHANGE_KEY);
    if (value && typeof value.modelId === "string") return value.modelId;
  }
  return undefined;
}

/** 分支上该虚拟模型最近一次记录的状态。 */
export function virtualModelState(
  branch: readonly SessionEntry[],
  modelId: string,
): JsonValue | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const value = metadataValue(branch[index]!, VIRTUAL_MODEL_STATE_KEY);
    if (value && value.modelId === modelId) return value.state;
  }
  return undefined;
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
  catalog: ModelCatalog,
  options: VirtualModelRoutingOptions,
): VirtualModelRouting {
  async function resolve(
    session: Pick<RuntimeRequestSession, "branch">,
    reason: ModelRouteReason,
    messages: readonly AgentMessage[],
    failed: AssistantMessage | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ selected: string; route: ResolvedRoute; state: JsonValue | undefined }> {
    const branch = session.branch();
    const selected = branchSelection(branch) ?? options.defaultModelId;
    const physical = catalog.physical(selected);
    if (physical) return { selected, route: { model: physical }, state: undefined };
    const state = reason === "direct" ? undefined : virtualModelState(branch, selected);
    const route = await resolveRoute(catalog, selected, {
      reason,
      messages,
      failed,
      state,
      signal,
    });
    return { selected, route, state };
  }

  return {
    async prepareRequest(request, session, signal) {
      const { selected, route, state } = await resolve(
        session,
        request.reason,
        request.context.messages,
        request.failed,
        signal,
      );
      if (route.state !== undefined && !sameState(route.state, state)) {
        session.record(VIRTUAL_MODEL_STATE_KEY, {
          modelId: selected,
          state: route.state as JsonValue,
        });
      }
      return {
        model: route.model.model,
        ...(route.thinkingLevel === undefined ? {} : { thinkingLevel: route.thinkingLevel }),
      };
    },
    async routeDirect(session, messages, signal) {
      return (await resolve(session, "direct", messages, undefined, signal)).route;
    },
  };
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
