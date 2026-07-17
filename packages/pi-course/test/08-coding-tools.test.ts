import assert from "node:assert/strict";
import {
  access,
  link,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runAgentLoop } from "../src/agent-loop.js";
import {
  createCodingTools,
  MutationQueue,
  type BashDetails,
  type EditDetails,
  type ReadDetails,
  type WriteDetails,
} from "../src/coding-tools.js";
import { ScriptedModel } from "../src/scripted-model.js";
import { executeToolCall } from "../src/tool.js";
import {
  assistantMessage,
  text,
  userMessage,
  type AgentMessage,
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

function outputOf(result: ToolResultMessage): string {
  return result.content.map((block) => block.text).join("\n");
}

function detailsOf<T>(result: ToolResultMessage): T {
  return result.details as T;
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`等待文件超时：${file}`);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface MutationRun {
  key: string;
  queue: MutationQueue;
}

function recordMutationRuns(t: TestContext): MutationRun[] {
  const runs: MutationRun[] = [];
  const originalRun = MutationQueue.prototype.run;
  MutationQueue.prototype.run = async function <T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    runs.push({ key, queue: this });
    return originalRun.call(this, key, operation) as Promise<T>;
  };
  t.after(() => {
    MutationQueue.prototype.run = originalRun;
  });
  return runs;
}

test("Lab 8.1 · Read 按行窗口返回正文，并让 details 与实际输出一致", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-read-window-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "notes.txt");
  const source = "one\ntwo\nthree\nfour";
  await writeFile(file, source, "utf8");
  const tools = createCodingTools({
    cwd: root,
    containment: "workspace",
    maxReadLines: 2,
  });

  const result = await executeToolCall(
    call("read-window", "read", {
      path: "notes.txt",
      offset: 2,
      limit: 9,
    }),
    tools,
  );

  assert.equal(result.isError, false, outputOf(result));
  assert.match(outputOf(result), /2│ two/);
  assert.match(outputOf(result), /3│ three/);
  assert.doesNotMatch(outputOf(result), /1│ one|4│ four/);
  assert.match(outputOf(result), /offset=4/);
  assert.deepEqual(detailsOf<ReadDetails>(result), {
    path: file,
    bytes: Buffer.byteLength(source),
    lines: 4,
    startLine: 2,
    endLine: 3,
    truncated: true,
  });

  const beyond = await executeToolCall(
    call("read-beyond", "read", {
      path: "notes.txt",
      offset: 5,
    }),
    tools,
  );
  assert.equal(beyond.isError, true);
  assert.match(outputOf(beyond), /offset=5 超出文件范围；文件共 4 行/);
});

test("Lab 8.1 · Read 的字节上限不会切断一行，续读也不会跳行", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-read-bytes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lines = [
    "alpha",
    "b".repeat(200),
    "charlie",
  ];
  await writeFile(path.join(root, "long.txt"), lines.join("\n"), "utf8");
  await writeFile(
    path.join(root, "one-huge-line.txt"),
    "界".repeat(100),
    "utf8",
  );
  const maxReadBytes = 120;
  const tools = createCodingTools({
    cwd: root,
    containment: "workspace",
    maxReadBytes,
  });

  const first = await executeToolCall(
    call("read-first", "read", { path: "long.txt" }),
    tools,
  );
  assert.equal(first.isError, false, outputOf(first));
  assert.ok(Buffer.byteLength(outputOf(first)) <= maxReadBytes);
  assert.equal(
    outputOf(first),
    "   1│ alpha\n\n[已显示第 1-1 行，共 3 行；继续读取：offset=2]",
  );
  assert.equal(detailsOf<ReadDetails>(first).endLine, 1);

  const continuationTools = createCodingTools({
    cwd: root,
    containment: "workspace",
    maxReadBytes: 400,
  });
  const second = await executeToolCall(
    call("read-second", "read", { path: "long.txt", offset: 2 }),
    continuationTools,
  );
  assert.equal(second.isError, false, outputOf(second));
  assert.match(outputOf(second), /2│ b{20}/);
  assert.doesNotMatch(outputOf(second), /1│ alpha/);
  assert.equal(detailsOf<ReadDetails>(second).startLine, 2);

  const tooSmall = createCodingTools({
    cwd: root,
    containment: "workspace",
    maxReadBytes: 64,
  });
  const impossible = await executeToolCall(
    call("read-impossible", "read", { path: "one-huge-line.txt" }),
    tooSmall,
  );
  assert.equal(impossible.isError, true);
  assert.match(
    outputOf(impossible),
    /无法返回从第 1 行开始的完整可续读结果/,
  );
});

test("Lab 8.2 · workspace 路径规则同时约束 Read、Write 与 Edit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-path-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-path-outside-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const outsideFile = path.join(outside, "secret.txt");
  await writeFile(outsideFile, "keep", "utf8");
  await symlink(outside, path.join(root, "escape"));
  const tools = createCodingTools({
    cwd: root,
    containment: "workspace",
  });

  const attempts = [
    call("outside-read", "read", { path: outsideFile }),
    call("outside-write", "write", {
      path: outsideFile,
      content: "replace",
    }),
    call("outside-edit", "edit", {
      path: outsideFile,
      oldText: "keep",
      newText: "replace",
    }),
  ];
  for (const attempt of attempts) {
    const result = await executeToolCall(attempt, tools);
    assert.equal(result.isError, true);
    assert.match(outputOf(result), /路径越过教学 workspace/);
  }

  const symlinkAttempts = [
    call("symlink-read", "read", { path: "escape/secret.txt" }),
    call("symlink-write", "write", {
      path: "escape/new.txt",
      content: "new",
    }),
    call("symlink-edit", "edit", {
      path: "escape/secret.txt",
      oldText: "keep",
      newText: "replace",
    }),
  ];
  for (const attempt of symlinkAttempts) {
    const result = await executeToolCall(attempt, tools);
    assert.equal(result.isError, true);
    assert.match(outputOf(result), /符号链接越过教学 workspace/);
  }
  assert.equal(await readFile(outsideFile, "utf8"), "keep");
  await assert.rejects(access(path.join(outside, "new.txt")), {
    code: "ENOENT",
  });
});

test("Lab 8.3 · Write 创建父目录、完整覆盖文件，并返回写入证据", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-write-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mutationRuns = recordMutationRuns(t);
  const tools = createCodingTools({
    cwd: root,
    containment: "workspace",
  });
  const file = path.join(root, "nested", "answer.txt");

  const created = await executeToolCall(
    call("write-create", "write", {
      path: "nested/answer.txt",
      content: "first",
    }),
    tools,
  );
  assert.equal(created.isError, false, outputOf(created));
  assert.equal(await readFile(file, "utf8"), "first");
  assert.deepEqual(detailsOf<WriteDetails>(created), {
    path: file,
    bytes: 5,
  });
  const hardLinkWitness = path.join(root, "nested", "first-version.txt");
  await link(file, hardLinkWitness);

  const overwritten = await executeToolCall(
    call("write-overwrite", "write", {
      path: "nested/answer.txt",
      content: "最终答案",
    }),
    tools,
  );
  assert.equal(overwritten.isError, false, outputOf(overwritten));
  assert.equal(await readFile(file, "utf8"), "最终答案");
  assert.equal(
    await readFile(hardLinkWitness, "utf8"),
    "first",
    "覆盖必须替换目录项，不能直接改写原 inode",
  );
  assert.equal(
    detailsOf<WriteDetails>(overwritten).bytes,
    Buffer.byteLength("最终答案"),
  );

  const blocked = path.join(root, "nested", "blocked");
  await mkdir(blocked);
  await writeFile(path.join(blocked, "keep.txt"), "keep", "utf8");
  const failed = await executeToolCall(
    call("write-rename-failure", "write", {
      path: "nested/blocked",
      content: "不能覆盖目录",
    }),
    tools,
  );
  assert.equal(failed.isError, true);
  assert.equal(await readFile(path.join(blocked, "keep.txt"), "utf8"), "keep");

  assert.deepEqual(
    mutationRuns.map(({ key }) => key),
    [file, file, blocked],
  );
  assert.ok(
    mutationRuns.every(({ queue }) => queue === mutationRuns[0]?.queue),
    "所有 Write 必须共用同一个默认修改队列",
  );
  assert.deepEqual(
    (await readdir(path.dirname(file))).filter((name) =>
      name.includes(".pi-tmp-")
    ),
    [],
  );
});

test("Lab 8.3 · 修改队列串行处理同一路径，同时允许不同路径继续执行", async () => {
  const queue = new MutationQueue();
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const order: string[] = [];

  const first = queue.run("same", async () => {
    order.push("same:first:start");
    firstStarted.resolve();
    await releaseFirst.promise;
    order.push("same:first:end");
  });
  await firstStarted.promise;

  const second = queue.run("same", async () => {
    order.push("same:second:start");
    order.push("same:second:end");
  });
  const other = queue.run("other", async () => {
    order.push("other:start");
    order.push("other:end");
  });

  await other;
  assert.deepEqual(order, [
    "same:first:start",
    "other:start",
    "other:end",
  ]);

  releaseFirst.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, [
    "same:first:start",
    "other:start",
    "other:end",
    "same:first:end",
    "same:second:start",
    "same:second:end",
  ]);

  await assert.rejects(
    queue.run("failed", async () => {
      throw new Error("expected failure");
    }),
    /expected failure/,
  );
  await queue.run("failed", async () => {
    order.push("failed:next-ran");
  });
  assert.equal(order.at(-1), "failed:next-ran");
});

test("Lab 8.4 · Edit 按顺序应用相互依赖的替换，并报告前后字节数", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-edit-order-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "value.txt");
  const source = "alpha beta";
  const mutationRuns = recordMutationRuns(t);
  const tools = createCodingTools({
    cwd: root,
    containment: "workspace",
  });
  const written = await executeToolCall(
    call("edit-setup", "write", {
      path: "value.txt",
      content: source,
    }),
    tools,
  );
  assert.equal(written.isError, false, outputOf(written));
  const hardLinkWitness = path.join(root, "before-edit.txt");
  await link(file, hardLinkWitness);

  const result = await executeToolCall(
    call("edit-order", "edit", {
      path: "value.txt",
      edits: [
        { oldText: "alpha", newText: "gamma" },
        { oldText: "gamma beta", newText: "done" },
      ],
    }),
    tools,
  );

  assert.equal(result.isError, false, outputOf(result));
  assert.equal(await readFile(file, "utf8"), "done");
  assert.equal(
    await readFile(hardLinkWitness, "utf8"),
    source,
    "Edit 必须在整批验证后替换目录项，不能直接改写原 inode",
  );
  assert.deepEqual(detailsOf<EditDetails>(result), {
    path: file,
    oldBytes: Buffer.byteLength(source),
    newBytes: Buffer.byteLength("done"),
    edits: 2,
  });
  const deleted = await executeToolCall(
    call("edit-delete", "edit", {
      path: "value.txt",
      oldText: "done",
      newText: "",
    }),
    tools,
  );
  assert.equal(deleted.isError, false, outputOf(deleted));
  assert.equal(await readFile(file, "utf8"), "");
  assert.deepEqual(
    mutationRuns.map(({ key }) => key),
    [file, file, file],
  );
  assert.ok(
    mutationRuns.every(({ queue }) => queue === mutationRuns[0]?.queue),
    "Write 与 Edit 必须共用同一个默认修改队列",
  );
});

test("Lab 8.4 · Edit 拒绝空批次、空匹配和多重匹配；中途失败时文件保持原样", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-edit-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "value.txt");
  const tools = createCodingTools({
    cwd: root,
    containment: "workspace",
  });

  await writeFile(file, "one two", "utf8");
  const emptyBatch = await executeToolCall(
    call("edit-empty-batch", "edit", {
      path: "value.txt",
      edits: [],
    }),
    tools,
  );
  assert.equal(emptyBatch.isError, true);
  assert.match(outputOf(emptyBatch), /edits 不能为空/);
  assert.equal(await readFile(file, "utf8"), "one two");

  const emptyMatch = await executeToolCall(
    call("edit-empty-match", "edit", {
      path: "value.txt",
      oldText: "",
      newText: "X",
    }),
    tools,
  );
  assert.equal(emptyMatch.isError, true);
  assert.match(outputOf(emptyMatch), /oldText 不能为空/);
  assert.equal(await readFile(file, "utf8"), "one two");

  await writeFile(file, "same same", "utf8");
  const repeated = await executeToolCall(
    call("edit-repeated", "edit", {
      path: "value.txt",
      oldText: "same",
      newText: "X",
    }),
    tools,
  );
  assert.equal(repeated.isError, true);
  assert.match(outputOf(repeated), /匹配多次/);
  assert.equal(await readFile(file, "utf8"), "same same");

  await writeFile(file, "one two", "utf8");
  const failedBatch = await executeToolCall(
    call("edit-rollback", "edit", {
      path: "value.txt",
      edits: [
        { oldText: "one", newText: "ONE" },
        { oldText: "missing", newText: "X" },
      ],
    }),
    tools,
  );
  assert.equal(failedBatch.isError, true);
  assert.match(outputOf(failedBatch), /edits\[1\] 没有匹配/);
  assert.equal(await readFile(file, "utf8"), "one two");
});

test("Lab 8.5 · Bash 在指定 cwd 返回成功输出，也保留非零退出码", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-bash-exit-"));
  const outsideMarker = path.join(
    path.dirname(root),
    `${path.basename(root)}-outside.txt`,
  );
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outsideMarker, { force: true });
  });
  const tools = createCodingTools({
    cwd: root,
    containment: "workspace",
  });

  const succeeded = await executeToolCall(
    call("bash-success", "bash", {
      command: "printf 'ok\\n'; pwd",
    }),
    tools,
  );
  assert.equal(succeeded.isError, false, outputOf(succeeded));
  assert.match(outputOf(succeeded), /^ok\n/);
  assert.equal(
    outputOf(succeeded).trimEnd().split("\n").at(-1),
    await realpath(root),
  );
  assert.equal(detailsOf<BashDetails>(succeeded).exitCode, 0);

  const failed = await executeToolCall(
    call("bash-nonzero", "bash", {
      command: "printf 'bad\\n' >&2; exit 7",
    }),
    tools,
  );
  assert.equal(failed.isError, true);
  assert.match(outputOf(failed), /bad/);
  assert.equal(detailsOf<BashDetails>(failed).exitCode, 7);
  assert.equal(detailsOf<BashDetails>(failed).timedOut, false);

  for (const guardedCall of [
    call("bash-guard-parent", "bash", {
      command: `printf escaped > ../${path.basename(outsideMarker)}`,
    }),
    call("bash-guard-absolute", "bash", {
      command: `printf escaped > ${outsideMarker}`,
    }),
  ]) {
    const guarded = await executeToolCall(guardedCall, tools);
    assert.equal(guarded.isError, true);
    assert.match(outputOf(guarded), /guardrail/);
    await assert.rejects(access(outsideMarker), { code: "ENOENT" });
  }
});

test("Lab 8.5 · 预先取消的 Bash 不会启动子进程", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-bash-precancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "started.txt");
  const tools = createCodingTools({
    cwd: root,
    containment: "workspace",
  });
  const controller = new AbortController();
  controller.abort();

  const result = await executeToolCall(
    call("bash-precancel", "bash", {
      command: "printf started > started.txt",
    }),
    tools,
    { signal: controller.signal },
  );

  assert.equal(result.isError, true);
  assert.equal(detailsOf<BashDetails>(result).aborted, true);
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("Lab 8.5 · Bash 的截断提示也计入输出字节上限", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-bash-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const maxBashOutputBytes = 64;
  const tools = createCodingTools({
    cwd: root,
    containment: "workspace",
    maxBashOutputBytes,
  });

  const result = await executeToolCall(
    call("bash-output", "bash", {
      command:
        "node -e \"process.stdout.write('x'.repeat(300)); process.stderr.write('y'.repeat(300))\"",
    }),
    tools,
  );

  assert.equal(result.isError, false, outputOf(result));
  assert.equal(detailsOf<BashDetails>(result).truncated, true);
  assert.ok(Buffer.byteLength(outputOf(result)) <= maxBashOutputBytes);
  assert.match(outputOf(result), /\[输出已截断\]$/);
});

test("Lab 8.5 · Bash 能区分超时和运行中的取消", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-bash-stop-"));
  const descendantPidFile = path.join(root, "descendant.pid");
  t.after(async () => {
    try {
      const descendantPid = Number(await readFile(descendantPidFile, "utf8"));
      process.kill(descendantPid, "SIGKILL");
    } catch {
      // 正确实现已经结束该进程，或者本平台没有运行后代场景。
    }
    await rm(root, { recursive: true, force: true });
  });

  const timeoutTools = createCodingTools({
    cwd: root,
    containment: "workspace",
    bashTimeoutMs: 200,
  });
  const timedOut = await executeToolCall(
    call("bash-timeout", "bash", {
      command:
        "node -e \"const fs=require('node:fs'); fs.writeFileSync('timeout-ready.txt','yes'); process.on('SIGTERM',()=>{fs.writeFileSync('timeout-stopped.txt','yes'); process.exit(0)}); setTimeout(()=>process.exit(0),1000)\"",
    }),
    timeoutTools,
  );
  assert.equal(timedOut.isError, true);
  assert.equal(detailsOf<BashDetails>(timedOut).timedOut, true);
  assert.equal(detailsOf<BashDetails>(timedOut).aborted, false);
  assert.equal(
    await readFile(path.join(root, "timeout-stopped.txt"), "utf8"),
    "yes",
  );

  const controller = new AbortController();
  const cancelTools = createCodingTools({
    cwd: root,
    containment: "workspace",
    bashTimeoutMs: 5_000,
  });
  const running = executeToolCall(
    call("bash-runtime-cancel", "bash", {
      command:
        "node -e \"const fs=require('node:fs'); fs.writeFileSync('running.txt','yes'); process.on('SIGTERM',()=>{fs.writeFileSync('cancel-stopped.txt','yes'); process.exit(0)}); setTimeout(()=>process.exit(0),1000)\"",
    }),
    cancelTools,
    { signal: controller.signal },
  );
  await waitForFile(path.join(root, "running.txt"));
  controller.abort();
  const cancelled = await running;
  assert.equal(cancelled.isError, true);
  assert.equal(detailsOf<BashDetails>(cancelled).aborted, true);
  assert.equal(detailsOf<BashDetails>(cancelled).timedOut, false);
  assert.equal(
    await readFile(path.join(root, "cancel-stopped.txt"), "utf8"),
    "yes",
  );

  if (process.platform !== "win32") {
    await writeFile(
      path.join(root, "descendant.cjs"),
      [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        "fs.writeFileSync('descendant-ready.txt', 'yes');",
        "setTimeout(() => fs.writeFileSync('descendant-survived.txt', 'yes'), 300);",
        "setTimeout(() => process.exit(0), 800);",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(root, "parent.cjs"),
      [
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['descendant.cjs'], { stdio: 'ignore' });",
        "fs.writeFileSync('descendant.pid', String(child.pid));",
        "setTimeout(() => process.exit(0), 1000);",
      ].join("\n"),
      "utf8",
    );
    const descendantTools = createCodingTools({
      cwd: root,
      containment: "workspace",
      bashTimeoutMs: 5_000,
    });
    const descendantController = new AbortController();
    const descendantPromise = executeToolCall(
      call("bash-descendant-cancel", "bash", {
        command: "node parent.cjs",
      }),
      descendantTools,
      { signal: descendantController.signal },
    );
    await waitForFile(path.join(root, "descendant-ready.txt"));
    descendantController.abort();
    const descendantRun = await descendantPromise;
    assert.equal(descendantRun.isError, true);
    assert.equal(detailsOf<BashDetails>(descendantRun).aborted, true);
    assert.equal(detailsOf<BashDetails>(descendantRun).timedOut, false);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await assert.rejects(
      access(path.join(root, "descendant-survived.txt")),
      { code: "ENOENT" },
    );
  }
});

test("Lab 8.6 · 真 Agent 循环完成 Read→Edit→Bash，并让每个 call 都有配对结果", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-tools-loop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "task.txt"), "draft", "utf8");
  const calls = [
    call("loop-read", "read", { path: "task.txt" }),
    call("loop-edit", "edit", {
      path: "task.txt",
      oldText: "draft",
      newText: "done",
    }),
    call("loop-bash", "bash", {
      command:
        "node -e \"const fs=require('node:fs'); if(fs.readFileSync('task.txt','utf8')!=='done') process.exit(2); process.stdout.write('verified')\"",
    }),
  ];
  const model = new ScriptedModel([
    assistantMessage([calls[0]], "toolUse"),
    assistantMessage([calls[1]], "toolUse"),
    assistantMessage([calls[2]], "toolUse"),
    assistantMessage([text("文件已经修改并通过检查。")], "stop"),
  ]);
  const tools = createCodingTools({
    cwd: root,
    containment: "workspace",
  });

  const run = await runAgentLoop({
    model,
    tools,
    context: { messages: [userMessage("把 task.txt 改成 done 并检查结果")] },
  });

  assert.equal(run.reason, "stop");
  assert.equal(await readFile(path.join(root, "task.txt"), "utf8"), "done");
  const results = run.messages.filter(
    (message): message is ToolResultMessage =>
      message.role === "toolResult",
  );
  assert.deepEqual(
    results.map((result) => ({
      id: result.toolCallId,
      name: result.toolName,
      isError: result.isError,
    })),
    calls.map((currentCall) => ({
      id: currentCall.id,
      name: currentCall.name,
      isError: false,
    })),
  );
  assert.match(outputOf(results[2]), /verified/);
  assert.equal(model.requests.length, 4);
  assert.deepEqual(
    run.messages.map((message: AgentMessage) => message.role),
    [
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "assistant",
    ],
  );
});
