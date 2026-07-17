import assert from "node:assert/strict";
import test from "node:test";
import {
  executeToolCall,
  objectSchema,
  optionalPositiveInteger,
  optionalString,
  stringValue,
  ToolRegistry,
  type Tool,
  type ToolContext,
} from "../src/tool.js";
import {
  text,
  type TextContent,
  type ToolCall,
  type ToolResultMessage,
} from "../src/types.js";

function call(
  id: string,
  name: string,
  argumentsValue: unknown,
): ToolCall {
  return {
    type: "toolCall",
    id,
    name,
    arguments: argumentsValue,
  };
}

function withoutTimestamp(
  result: ToolResultMessage,
): Omit<ToolResultMessage, "timestamp"> {
  const { timestamp: _timestamp, ...stable } = result;
  return stable;
}

test("validator 收窄 unknown，并生成精确 JSON Schema", () => {
  const schema = objectSchema({
    value: stringValue,
    label: optionalString,
    limit: optionalPositiveInteger,
  });

  assert.deepEqual(schema.jsonSchema, {
    type: "object",
    properties: {
      value: { type: "string" },
      label: { type: "string" },
      limit: { type: "integer", minimum: 1 },
    },
    required: ["value"],
    additionalProperties: false,
  });
  assert.deepEqual(
    schema.parse({
      value: "Pi",
      label: "answer",
      limit: 2,
      ignored: "drop me",
    }),
    { value: "Pi", label: "answer", limit: 2 },
  );
  assert.deepEqual(schema.parse({ value: "Pi" }), {
    value: "Pi",
    label: undefined,
    limit: undefined,
  });
  assert.throws(() => schema.parse(null), /参数必须是 object/);
  assert.throws(() => schema.parse({ value: 1 }), /必须是 string/);
  assert.throws(
    () => schema.parse({ value: "Pi", limit: 0 }),
    /必须是正整数/,
  );
});

test("Registry 接收初始工具、拒绝重名，并只暴露 provider definition", () => {
  const echo: Tool<{ value: string }> = {
    name: "echo",
    description: "Echo one value",
    schema: objectSchema({ value: stringValue }),
    async execute({ value }: { value: string }) {
      return { content: [text(value)] };
    },
  };
  const upper: Tool<{ value: string }> = {
    name: "upper",
    description: "Uppercase one value",
    schema: objectSchema({ value: stringValue }),
    async execute({ value }: { value: string }) {
      return { content: [text(value.toUpperCase())] };
    },
  };
  const tools = new ToolRegistry([echo, upper]);

  assert.deepEqual(tools.list(), [echo, upper]);
  assert.deepEqual(tools.definitions(), [
    {
      name: "echo",
      description: "Echo one value",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
    {
      name: "upper",
      description: "Uppercase one value",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
  ]);
  assert.throws(() => tools.register(echo), /Tool 已存在：echo/);
});

test(
  "执行器让成功与三种失败形成完整配对结果",
  { timeout: 1_000 },
  async () => {
    let executionCount = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "echo",
      schema: objectSchema({ value: stringValue }),
      async execute({ value }: { value: string }) {
        executionCount += 1;
        return {
          content: [text(value)],
          details: { source: "echo" },
        };
      },
    });
    tools.register({
      name: "boom",
      description: "throw",
      schema: objectSchema({ value: stringValue }),
      async execute(_input: { value: string }) {
        throw new Error("exploded");
      },
    });

    const success = await executeToolCall(
      call("ok", "echo", { value: "Pi" }),
      tools,
    );
    const missing = await executeToolCall(
      call("m", "missing", {}),
      tools,
    );
    const invalid = await executeToolCall(
      call("i", "echo", { value: 1 }),
      tools,
    );
    const thrown = await executeToolCall(
      call("t", "boom", { value: "x" }),
      tools,
    );

    assert.equal(executionCount, 1);
    assert.deepEqual(withoutTimestamp(success), {
      role: "toolResult",
      toolCallId: "ok",
      toolName: "echo",
      content: [text("Pi")],
      details: { source: "echo" },
      isError: false,
    });
    assert.deepEqual(withoutTimestamp(missing), {
      role: "toolResult",
      toolCallId: "m",
      toolName: "missing",
      content: [text("Tool missing failed: 未知工具")],
      details: { error: "未知工具" },
      isError: true,
    });
    assert.deepEqual(withoutTimestamp(invalid), {
      role: "toolResult",
      toolCallId: "i",
      toolName: "echo",
      content: [text("Tool echo failed: 必须是 string")],
      details: { error: "必须是 string" },
      isError: true,
    });
    assert.deepEqual(withoutTimestamp(thrown), {
      role: "toolResult",
      toolCallId: "t",
      toolName: "boom",
      content: [text("Tool boom failed: exploded")],
      details: { error: "exploded" },
      isError: true,
    });
    for (const result of [success, missing, invalid, thrown]) {
      assert.equal(Number.isFinite(result.timestamp), true);
    }
  },
);

test(
  "执行器把 callId、signal 与 progress 交给工具，并保留 output",
  { timeout: 1_000 },
  async () => {
    const abortController = new AbortController();
    const progress: TextContent[][] = [];
    const reportProgress = (content: TextContent[]): void => {
      progress.push(content);
    };
    let seenContext: ToolContext | undefined;
    const tools = new ToolRegistry();
    tools.register({
      name: "inspect",
      description: "inspect context",
      schema: objectSchema({ value: stringValue }),
      async execute(
        { value }: { value: string },
        context: ToolContext,
      ) {
        seenContext = context;
        context.reportProgress?.([text(`progress:${value}`)]);
        return {
          content: [text(`done:${value}`)],
          details: { phase: "domain-error" },
          isError: true,
        };
      },
    });

    const result = await executeToolCall(
      call("ctx", "inspect", { value: "Pi" }),
      tools,
      {
        signal: abortController.signal,
        reportProgress,
      },
    );

    assert.ok(seenContext);
    assert.equal(seenContext.callId, "ctx");
    assert.equal(seenContext.signal, abortController.signal);
    assert.equal(seenContext.reportProgress, reportProgress);
    assert.deepEqual(progress, [[text("progress:Pi")]]);
    assert.deepEqual(withoutTimestamp(result), {
      role: "toolResult",
      toolCallId: "ctx",
      toolName: "inspect",
      content: [text("done:Pi")],
      details: { phase: "domain-error" },
      isError: true,
    });
  },
);
