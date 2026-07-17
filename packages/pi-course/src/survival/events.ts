export type DemoEvent =
  | { type: "started"; requestId: string }
  | { type: "delta"; requestId: string; text: string }
  | {
      type: "finished";
      requestId: string;
      reason: "stop" | "length";
    }
  | { type: "aborted"; requestId: string };

export function formatEvent(event: DemoEvent): string {
  switch (event.type) {
    case "started":
      return `start ${event.requestId}`;
    case "delta":
      return `delta ${event.requestId} ${event.text}`;
    case "finished":
      return `finish ${event.requestId} ${event.reason}`;
    case "aborted":
      return `abort ${event.requestId}`;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

export function readDelta(value: unknown): DemoEvent {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "type" in value &&
    value.type === "delta" &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    "text" in value &&
    typeof value.text === "string"
  ) {
    return {
      type: "delta",
      requestId: value.requestId,
      text: value.text,
    };
  }
  throw new Error("invalid delta event");
}
