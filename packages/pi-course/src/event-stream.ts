import type {
  AssistantMessage,
  ModelEvent,
  ModelStream,
} from "./types.js";

export class EventStream<T, R = T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private readonly waiting: Array<(value: IteratorResult<T>) => void> = [];
  private done = false;
  private readonly finalResult: Promise<R>;
  private resolveFinalResult!: (result: R) => void;

  constructor(
    private readonly isComplete: (event: T) => boolean,
    private readonly extractResult: (event: T) => R,
  ) {
    this.finalResult = new Promise<R>((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: T): void {
    if (this.done) return;
    if (this.isComplete(event)) {
      this.done = true;
      this.resolveFinalResult(this.extractResult(event));
    }

    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  end(result: R): void {
    if (!this.done) this.resolveFinalResult(result);
    this.done = true;
    while (this.waiting.length > 0) {
      this.waiting.shift()?.({
        value: undefined as T,
        done: true,
      });
    }
  }

  result(): Promise<R> {
    return this.finalResult;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift() as T;
        continue;
      }
      if (this.done) return;

      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiting.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

export class AssistantMessageEventStream
  extends EventStream<ModelEvent, AssistantMessage>
  implements ModelStream
{
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("非终态事件不能生成最终消息");
      },
    );
  }
}
