import assert from "node:assert/strict";
import test from "node:test";
import {
  formatEvent,
  readDelta,
  type DemoEvent,
} from "../src/survival/events.js";

test("tagged union 的完成态覆盖所有事件", () => {
  const events: DemoEvent[] = [
    { type: "started", requestId: "r1" },
    { type: "delta", requestId: "r1", text: "Pi" },
    { type: "finished", requestId: "r1", reason: "stop" },
    { type: "aborted", requestId: "r2" },
  ];
  assert.deepEqual(events.map(formatEvent), [
    "start r1",
    "delta r1 Pi",
    "finish r1 stop",
    "abort r2",
  ]);
});

test("unknown 必须先通过运行时边界", () => {
  assert.equal(
    formatEvent(readDelta({
      type: "delta",
      requestId: "r1",
      text: "Pi",
    })),
    "delta r1 Pi",
  );
  assert.throws(
    () => readDelta({ type: "delta", requestId: "r1", text: 42 }),
    /invalid delta event/,
  );
});
