import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenAICompatibleModel,
  createOpenAICompatibleTransport,
  fixedTransport,
  toProviderMessages,
  toProviderTools,
  type ProviderTransport,
} from "../src/provider-adapter.js";
import {
  assistantMessage,
  currentSystemPrompt,
  text,
  userMessage,
  type AgentContext,
  type AssistantContent,
  type AssistantMessage,
  type ModelEvent,
  type ModelStream,
} from "../src/types.js";

function sseResponse(payloads: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = payloads
    .map((payload) =>
      `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`
    )
    .join("");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = encoder.encode(body);
        const middle = Math.floor(bytes.length / 2);
        controller.enqueue(bytes.slice(0, middle));
        controller.enqueue(bytes.slice(middle));
        controller.close();
      },
    }),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

async function consume(
  stream: ModelStream,
): Promise<{ events: ModelEvent[]; result: AssistantMessage }> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

function withoutTimestamp(
  message: AssistantMessage,
): Omit<AssistantMessage, "timestamp"> {
  const { timestamp: _timestamp, ...stable } = message;
  return stable;
}

test(
  "normalized transport 经 adapter 保留首次出现顺序，并累计完整 partial",
  { timeout: 1_000 },
  async () => {
    const model = createOpenAICompatibleModel({
      provider: "fixture",
      model: "fixture-1",
      transport: fixedTransport([
        {
          type: "tool",
          index: 4,
          id: "call-read",
          name: "read",
          argumentsDelta: '{"path":',
        },
        { type: "text", delta: "先读" },
        {
          type: "tool",
          index: 2,
          id: "call-search",
          name: "search",
          argumentsDelta: '{"query":',
        },
        {
          type: "tool",
          index: 4,
          argumentsDelta: '"README.md"}',
        },
        { type: "text", delta: "，再查" },
        {
          type: "tool",
          index: 2,
          argumentsDelta: '"pi"}',
        },
        {
          type: "finish",
          reason: "tool_calls",
          usage: { input: 7, output: 5, totalTokens: 12 },
        },
      ]),
    });

    const { events, result } = await consume(
      model.stream({ messages: [userMessage("go")] }),
    );
    const deltas = events.filter(
      (
        event,
      ): event is Extract<
        ModelEvent,
        { type: "text_delta" | "toolcall_delta" }
      > =>
        event.type === "text_delta" || event.type === "toolcall_delta",
    );
    const ends = events.filter(
      (
        event,
      ): event is Extract<ModelEvent, { type: "toolcall_end" }> =>
        event.type === "toolcall_end",
    );
    const readOpening: AssistantContent = {
      type: "toolCall",
      id: "call-read",
      name: "read",
      arguments: '{"path":',
      rawArguments: '{"path":',
    };
    const readRaw: AssistantContent = {
      ...readOpening,
      arguments: '{"path":"README.md"}',
      rawArguments: '{"path":"README.md"}',
    };
    const searchOpening: AssistantContent = {
      type: "toolCall",
      id: "call-search",
      name: "search",
      arguments: '{"query":',
      rawArguments: '{"query":',
    };
    const searchRaw: AssistantContent = {
      ...searchOpening,
      arguments: '{"query":"pi"}',
      rawArguments: '{"query":"pi"}',
    };
    const readFinal: AssistantContent = {
      ...readRaw,
      arguments: { path: "README.md" },
    };
    const searchFinal: AssistantContent = {
      ...searchRaw,
      arguments: { query: "pi" },
    };
    const firstText: AssistantContent = { type: "text", text: "先读" };
    const finalText: AssistantContent = {
      type: "text",
      text: "先读，再查",
    };
    const finalContent = [readFinal, finalText, searchFinal];

    assert.deepEqual(events.map((event) => event.type), [
      "start",
      "toolcall_delta",
      "text_delta",
      "toolcall_delta",
      "toolcall_delta",
      "text_delta",
      "toolcall_delta",
      "toolcall_end",
      "toolcall_end",
      "done",
    ]);
    assert.deepEqual(
      deltas.map(({ type, contentIndex, delta }) => ({
        type,
        contentIndex,
        delta,
      })),
      [
        {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: '{"path":',
        },
        { type: "text_delta", contentIndex: 1, delta: "先读" },
        {
          type: "toolcall_delta",
          contentIndex: 2,
          delta: '{"query":',
        },
        {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: '"README.md"}',
        },
        { type: "text_delta", contentIndex: 1, delta: "，再查" },
        {
          type: "toolcall_delta",
          contentIndex: 2,
          delta: '"pi"}',
        },
      ],
    );
    assert.deepEqual(
      deltas.map((event) => event.partial.content),
      [
        [
          readOpening,
        ],
        [
          readOpening,
          firstText,
        ],
        [
          readOpening,
          firstText,
          searchOpening,
        ],
        [
          readRaw,
          firstText,
          searchOpening,
        ],
        [
          readRaw,
          finalText,
          searchOpening,
        ],
        [
          readRaw,
          finalText,
          searchRaw,
        ],
      ],
    );
    for (const event of deltas) {
      assert.deepEqual(withoutTimestamp(event.partial), {
        role: "assistant",
        content: event.partial.content,
        provider: "fixture",
        model: "fixture-1",
        usage: { input: 0, output: 0, totalTokens: 0 },
        stopReason: "stop",
      });
    }
    assert.deepEqual(
      ends.map(({ contentIndex, toolCall, partial }) => ({
        contentIndex,
        toolCall,
        partial: partial.content,
      })),
      [
        {
          contentIndex: 0,
          toolCall: readFinal,
          partial: [
            readFinal,
            finalText,
            searchRaw,
          ],
        },
        {
          contentIndex: 2,
          toolCall: searchFinal,
          partial: finalContent,
        },
      ],
    );
    assert.deepEqual(withoutTimestamp(result), {
      role: "assistant",
      content: finalContent,
      provider: "fixture",
      model: "fixture-1",
      usage: { input: 7, output: 5, totalTokens: 12 },
      stopReason: "toolUse",
    });
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "done");
    if (terminal?.type === "done") {
      assert.equal(terminal.reason, "toolUse");
      assert.deepEqual(terminal.message, result);
    }
  },
);

test("出站转换只在 adapter 边界完成 canonical 到 wire role 映射", () => {
  const context: AgentContext = {
    messages: [
      { role: "system", content: "You are precise.", timestamp: 0 },
      {
        role: "user" as const,
        content: [text("read a.txt"), text("then search")],
        timestamp: 1,
      },
      assistantMessage(
        [
          text("I will inspect both."),
          {
            type: "toolCall",
            id: "call-1",
            name: "read",
            arguments: { path: "wrong.txt" },
            rawArguments: '{"path":"a.txt"}',
          },
          {
            type: "toolCall",
            id: "call-2",
            name: "search",
            arguments: { query: "pi" },
          },
        ],
        "toolUse",
      ),
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [text("A"), text("B")],
        isError: false,
        timestamp: 1,
      },
    ],
  };
  const inputSnapshot = structuredClone(context);

  const messages = toProviderMessages(context);

  assert.deepEqual(messages, [
    { role: "system", content: "You are precise." },
    { role: "user", content: "read a.txt\nthen search" },
    {
      role: "assistant",
      content: "I will inspect both.",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "read", arguments: '{"path":"a.txt"}' },
        },
        {
          id: "call-2",
          type: "function",
          function: { name: "search", arguments: '{"query":"pi"}' },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call-1",
      name: "read",
      content: "A\nB",
    },
  ]);
  assert.deepEqual(context, inputSnapshot);
  assert.deepEqual(
    toProviderTools([
      {
        name: "read",
        description: "Read one file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ]),
    [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read one file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ],
  );
});

test("多条 system message 在出线时折叠成一条开头 system，中途的不进入 wire", () => {
  const context: AgentContext = {
    messages: [
      {
        role: "system",
        content: "BASE",
        sections: { rules: "RULE v1", scratch: "SCRATCH" },
        timestamp: 0,
      },
      { role: "user", content: [text("first")], timestamp: 1 },
      assistantMessage([text("ok")]),
      {
        role: "system",
        content: "",
        sections: { rules: "RULE v2", scratch: null },
        timestamp: 2,
      },
      { role: "user", content: [text("second")], timestamp: 3 },
    ],
  };
  const inputSnapshot = structuredClone(context);

  const messages = toProviderMessages(context);

  assert.deepEqual(messages, [
    { role: "system", content: "BASE\n\nRULE v2" },
    { role: "user", content: "first" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "second" },
  ]);
  assert.equal(
    messages.filter((message) => message.role === "system").length,
    1,
  );
  assert.equal(
    currentSystemPrompt(context.messages),
    "BASE\n\nRULE v2",
    "折叠结果就是 transcript 的重放结果",
  );
  assert.deepEqual(
    context,
    inputSnapshot,
    "折叠只发生在请求出线那一刻，不回写 transcript",
  );
  assert.deepEqual(
    toProviderMessages({ messages: [userMessage("no system")] }).map(
      (message) => message.role,
    ),
    ["user"],
  );
});

test("normalized transport 异常保留 partial 并进入 error", { timeout: 1_000 }, async () => {
  const transport: ProviderTransport = {
    async *stream() {
      yield { type: "text", delta: "partial" } as const;
      throw new Error("socket reset");
    },
  };
  const model = createOpenAICompatibleModel({
    provider: "fixture",
    model: "fixture-1",
    transport,
  });
  const stream = model.stream({ messages: [userMessage("go")] });
  for await (const _event of stream) {
    // 消费到终态。
  }
  const result = await stream.result();
  assert.equal(result.stopReason, "error");
  assert.equal(result.content[0]?.type, "text");
  assert.equal(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    "partial",
  );
});

test("normalized transport 的 length 保留原始 arguments", { timeout: 1_000 }, async () => {
  const rawArguments = '{"path":"a';
  const model = createOpenAICompatibleModel({
    provider: "fixture",
    model: "fixture-1",
    transport: fixedTransport([
      {
        type: "tool",
        index: 0,
        id: "call-1",
        name: "read",
        argumentsDelta: rawArguments,
      },
      { type: "finish", reason: "length" },
    ]),
  });
  const stream = model.stream({ messages: [userMessage("go")] });
  for await (const _event of stream) {
    // 消费到终态。
  }
  const result = await stream.result();
  const call = result.content.find(
    (block: AssistantContent) => block.type === "toolCall",
  );
  assert.equal(result.stopReason, "length");
  assert.equal(call?.type === "toolCall" ? call.arguments : "", rawArguments);
  assert.equal(
    call?.type === "toolCall" ? call.rawArguments : "",
    rawArguments,
  );
});

test("fetch transport 发出完整请求且不把 API key 写进 JSON body", { timeout: 1_000 }, async () => {
  const abortController = new AbortController();
  let captured:
    | { input: string | URL | Request; init: RequestInit | undefined }
    | undefined;
  const transport = createOpenAICompatibleTransport({
    baseUrl: "https://provider.invalid/v1/",
    apiKey: "offline-test-key",
    fetch: async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      captured = { input, init };
      return sseResponse([
        {
          choices: [
            { index: 0, delta: {}, finish_reason: "stop" },
          ],
        },
        "[DONE]",
      ]);
    },
  });
  const model = createOpenAICompatibleModel({
    provider: "fixture",
    model: "fixture-1",
    transport,
  });

  const { result } = await consume(
    model.stream(
      {
        messages: [userMessage("read a.txt")],
        tools: [
          {
            name: "read",
            description: "Read one file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      },
      { signal: abortController.signal },
    ),
  );

  assert.equal(result.stopReason, "stop");
  assert.ok(captured);
  assert.equal(String(captured.input), "https://provider.invalid/v1/chat/completions");
  assert.equal(captured.init?.method, "POST");
  assert.equal(captured.init?.signal, abortController.signal);
  const headers = new Headers(captured.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer offline-test-key");
  assert.equal(headers.get("accept"), "text/event-stream");
  assert.equal(headers.get("content-type"), "application/json");
  const body = JSON.parse(String(captured.init?.body)) as {
    model: string;
    messages: unknown[];
    stream: boolean;
    stream_options: { include_usage: boolean };
    tools: unknown[];
  };
  assert.deepEqual(body, {
    model: "fixture-1",
    messages: [{ role: "user", content: "read a.txt" }],
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read one file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ],
    stream: true,
    stream_options: { include_usage: true },
  });
  assert.equal(Object.hasOwn(body, "apiKey"), false);
  assert.doesNotMatch(JSON.stringify(body), /offline-test-key/);
});

test("SSE transport 按 index 恢复交错 tool arguments，并合并尾随 usage", { timeout: 1_000 }, async () => {
  const transport = createOpenAICompatibleTransport({
    baseUrl: "https://provider.invalid/v1",
    apiKey: "offline-test-key",
    fetch: async () =>
      sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-read",
                    type: "function",
                    function: {
                      name: "read",
                      arguments: "{\"path\":",
                    },
                  },
                  {
                    index: 1,
                    id: "call-search",
                    type: "function",
                    function: {
                      name: "search",
                      arguments: "{\"query\":",
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 1,
                    function: { arguments: "\"pi\"}" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: "\"README.md\"}" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "tool_calls",
            },
          ],
        },
        {
          choices: [],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 8,
            total_tokens: 20,
          },
        },
        "[DONE]",
      ]),
  });
  const model = createOpenAICompatibleModel({
    provider: "fixture",
    model: "fixture-1",
    transport,
  });

  const { events, result } = await consume(
    model.stream({ messages: [userMessage("use tools")] }),
  );

  assert.equal(result.stopReason, "toolUse");
  assert.deepEqual(result.usage, {
    input: 12,
    output: 8,
    totalTokens: 20,
  });
  const calls = result.content.filter((block) => block.type === "toolCall");
  assert.deepEqual(
    calls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      rawArguments: call.rawArguments,
    })),
    [
      {
        id: "call-read",
        name: "read",
        arguments: { path: "README.md" },
        rawArguments: "{\"path\":\"README.md\"}",
      },
      {
        id: "call-search",
        name: "search",
        arguments: { query: "pi" },
        rawArguments: "{\"query\":\"pi\"}",
      },
    ],
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "toolcall_delta")
      .map((event) => event.delta),
    ["{\"path\":", "{\"query\":", "\"pi\"}", "\"README.md\"}"],
  );
});

test("SSE 缺少 finish reason 时保留 partial 并进入 error 终态", { timeout: 1_000 }, async () => {
  const transport = createOpenAICompatibleTransport({
    baseUrl: "https://provider.invalid/v1",
    apiKey: "offline-test-key",
    fetch: async () =>
      sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: { content: "partial" },
              finish_reason: null,
            },
          ],
        },
        "[DONE]",
      ]),
  });
  const model = createOpenAICompatibleModel({
    provider: "fixture",
    model: "fixture-1",
    transport,
  });

  const { events, result } = await consume(
    model.stream({ messages: [userMessage("go")] }),
  );

  assert.equal(events.at(-1)?.type, "error");
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /without a finish chunk/);
  assert.equal(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    "partial",
  );
});

test("SSE transport 把流中取消转换成 aborted，并保留 partial", { timeout: 1_000 }, async () => {
  const abortController = new AbortController();
  const encoder = new TextEncoder();
  let seenSignal: AbortSignal | null | undefined;
  const transport = createOpenAICompatibleTransport({
    baseUrl: "https://provider.invalid/v1",
    apiKey: "offline-test-key",
    fetch: async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      seenSignal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  choices: [
                    {
                      index: 0,
                      delta: { content: "partial" },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`,
              ),
            );
            init?.signal?.addEventListener(
              "abort",
              () => {
                controller.error(
                  new DOMException("Request was aborted", "AbortError"),
                );
              },
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const model = createOpenAICompatibleModel({
    provider: "fixture",
    model: "fixture-1",
    transport,
  });
  const stream = model.stream(
    { messages: [userMessage("go")] },
    { signal: abortController.signal },
  );
  const events: ModelEvent[] = [];

  for await (const event of stream) {
    events.push(event);
    if (event.type === "text_delta") abortController.abort();
  }
  const result = await stream.result();
  const lastEvent = events.at(-1);

  assert.equal(seenSignal, abortController.signal);
  assert.equal(lastEvent?.type, "error");
  assert.equal(
    lastEvent?.type === "error" ? lastEvent.reason : "",
    "aborted",
  );
  assert.equal(result.stopReason, "aborted");
  assert.equal(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    "partial",
  );
});

test("SSE transport 拒绝形状无效的外部 chunk", { timeout: 1_000 }, async () => {
  const transport = createOpenAICompatibleTransport({
    baseUrl: "https://provider.invalid/v1",
    apiKey: "offline-test-key",
    fetch: async () =>
      sseResponse([{ choices: "not-an-array" }, "[DONE]"]),
  });
  const model = createOpenAICompatibleModel({
    provider: "fixture",
    model: "fixture-1",
    transport,
  });

  const { events, result } = await consume(
    model.stream({ messages: [userMessage("go")] }),
  );

  assert.equal(events.at(-1)?.type, "error");
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /Invalid provider chunk/);
});

test("SSE transport 拒绝未知 finish reason，错误中不泄露 API key", { timeout: 1_000 }, async () => {
  const apiKey = "never-print-this-secret";
  const transport = createOpenAICompatibleTransport({
    baseUrl: "https://provider.invalid/v1",
    apiKey,
    fetch: async () =>
      sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "content_filter",
            },
          ],
        },
        "[DONE]",
      ]),
  });
  const model = createOpenAICompatibleModel({
    provider: "fixture",
    model: "fixture-1",
    transport,
  });

  const { result } = await consume(
    model.stream({ messages: [userMessage("go")] }),
  );

  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /finish_reason/);
  assert.doesNotMatch(result.errorMessage ?? "", new RegExp(apiKey));
});

test("fetch transport 会脱敏底层错误中的 API key", { timeout: 1_000 }, async () => {
  const apiKey = "never-print-this-secret";
  const transport = createOpenAICompatibleTransport({
    baseUrl: "https://provider.invalid/v1",
    apiKey,
    fetch: async () => {
      throw new Error(`socket failed while using ${apiKey}`);
    },
  });
  const model = createOpenAICompatibleModel({
    provider: "fixture",
    model: "fixture-1",
    transport,
  });

  const { result } = await consume(
    model.stream({ messages: [userMessage("go")] }),
  );

  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /\[redacted\]/);
  assert.doesNotMatch(result.errorMessage ?? "", new RegExp(apiKey));
});
