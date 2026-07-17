import assert from "node:assert/strict";
import test from "node:test";
import { EventStream } from "../src/event-stream.js";

type Event =
  | { type: "delta"; value: string }
  | { type: "done"; value: string };

function stream(): EventStream<Event, string> {
  return new EventStream(
    (event: Event) => event.type === "done",
    (event: Event) => event.value,
  );
}

test("先到的事件进入 queue，终态同时完成 result", async () => {
  const events = stream();
  events.push({ type: "delta", value: "A" });
  events.push({ type: "done", value: "AB" });

  const observed: Event[] = [];
  for await (const event of events) observed.push(event);
  assert.deepEqual(observed.map((event) => event.type), ["delta", "done"]);
  assert.equal(await events.result(), "AB");
});

test("先等待的 iterator 由下一次 push 唤醒", async () => {
  const events = stream();
  const iterator = events[Symbol.asyncIterator]();
  const pending = iterator.next();
  events.push({ type: "delta", value: "A" });
  assert.deepEqual(await pending, {
    value: { type: "delta", value: "A" },
    done: false,
  });
  events.end("A");
  assert.equal((await iterator.next()).done, true);
  assert.equal(await events.result(), "A");
});
