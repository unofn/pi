import { AssistantMessageEventStream } from "./event-stream.js";
import {
  assistantMessage,
  type AgentContext,
  type AssistantMessage,
  type Model,
  type ModelEvent,
  type ToolCall,
} from "./types.js";

export type ScriptedTurn =
  | AssistantMessage
  | {
      stopReason: "error" | "aborted";
      errorMessage: string;
      partialText?: string;
    };

function terminalMessage(turn: ScriptedTurn): AssistantMessage {
  if ("role" in turn) return structuredClone(turn);
  return assistantMessage(
    turn.partialText ? [{ type: "text", text: turn.partialText }] : [],
    turn.stopReason,
    { errorMessage: turn.errorMessage },
  );
}

function partialFrom(message: AssistantMessage): AssistantMessage {
  return {
    ...structuredClone(message),
    content: [],
    stopReason: "stop",
  };
}

/**
 * ScriptedModel 不是 mock 掉设计问题，而是把预期的多轮行为写成可执行规格。
 */
export class ScriptedModel implements Model {
  readonly requests: AgentContext[] = [];
  private cursor = 0;

  constructor(private readonly turns: ScriptedTurn[]) {}

  stream(
    context: AgentContext,
    options: { signal?: AbortSignal } = {},
  ): AssistantMessageEventStream {
    const stream = new AssistantMessageEventStream();
    this.requests.push(structuredClone(context));
    const turn = this.turns[this.cursor++];

    queueMicrotask(() => {
      if (options.signal?.aborted) {
        const aborted = assistantMessage([], "aborted", {
          errorMessage: "Request was aborted",
        });
        stream.push({ type: "error", reason: "aborted", error: aborted });
        stream.end(aborted);
        return;
      }

      if (!turn) {
        const exhausted = assistantMessage([], "error", {
          errorMessage: "ScriptedModel 没有更多响应",
        });
        stream.push({ type: "error", reason: "error", error: exhausted });
        stream.end(exhausted);
        return;
      }

      const message = terminalMessage(turn);
      const partial = partialFrom(message);
      stream.push({ type: "start", partial: structuredClone(partial) });

      message.content.forEach((block, contentIndex) => {
        if (block.type === "text") {
          partial.content = [
            ...partial.content,
            structuredClone(block),
          ];
          stream.push({
            type: "text_delta",
            contentIndex,
            delta: block.text,
            partial: structuredClone(partial),
          });
        } else {
          const toolCall = structuredClone(block) as ToolCall;
          const rawArguments =
            toolCall.rawArguments ??
            JSON.stringify(toolCall.arguments) ??
            "null";
          partial.content = [
            ...partial.content,
            {
              ...toolCall,
              arguments: {},
              rawArguments,
            },
          ];
          stream.push({
            type: "toolcall_delta",
            contentIndex,
            delta: rawArguments,
            partial: structuredClone(partial),
          });
          partial.content[contentIndex] = toolCall;
          stream.push({
            type: "toolcall_end",
            contentIndex,
            toolCall,
            partial: structuredClone(partial),
          });
        }
      });

      const terminal: ModelEvent =
        message.stopReason === "error" || message.stopReason === "aborted"
          ? {
              type: "error",
              reason: message.stopReason,
              error: message,
            }
          : {
              type: "done",
              reason: message.stopReason,
              message,
            };
      stream.push(terminal);
      stream.end(message);
    });

    return stream;
  }
}
