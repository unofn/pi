import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(packageRoot, "..", "..");
const requested = process.argv[2]?.padStart(2, "0");
const starterOverlays = {
  "05": [
    {
      source: "starters/05-provider-adapter.ts",
      destination: "src/provider-adapter.ts",
      description:
        "provider-adapter.ts 只提供公共类型、函数签名和按 Lab 编号的显式异常，不包含转换、状态机、SSE 或安全逻辑。",
    },
  ],
  "06": [
    {
      source: "starters/06-tool.ts",
      destination: "src/tool.ts",
      description:
        "tool.ts 只提供 Schema、Tool、Registry 与 executor 的公共签名和按 Lab 编号的显式异常，不包含验证、注册、执行或结果归一化算法。",
    },
  ],
  "07": [
    {
      source: "starters/07-agent-loop.ts",
      destination: "src/agent-loop.ts",
      description:
        "agent-loop.ts 只提供公共类型、主循环骨架与 Lab 7.1–7.5 的明确施工位，不包含终态配对、并发执行、错误归一化或取消算法。",
    },
  ],
  "08": [
    {
      source: "starters/08-coding-tools.ts",
      destination: "src/coding-tools.ts",
      description:
        "coding-tools.ts 只保留公共选项、结果类型、工具参数表面与 Lab 8.1–8.6 的明确施工位，不包含路径解析、文件变更、进程控制或截断算法。",
    },
  ],
  "09": [
    {
      source: "starters/09-agent.ts",
      destination: "src/agent.ts",
      description:
        "agent.ts 只保留 AgentOptions、AgentState、AgentEvent、reducer 与 Agent 的公共签名，以及 Lab 9.1–9.5 的明确施工位；不包含状态迁移、生命周期清理、订阅者隔离、取消传播或队列消费算法。",
    },
    {
      source: "starters/09-agent-loop.ts",
      destination: "src/agent-loop.ts",
      description:
        "agent-loop.ts 保留 Chapter 08 已完成的模型、工具、终态与取消算法，只增加 Chapter 09 的队列 hook 签名和 Lab 9.2–9.5 施工位；不包含异常保真、结果归一化、队列追加、继续循环或终态优先级答案。",
    },
  ],
  "10": [
    {
      source: "starters/10-session.ts",
      destination: "src/session.ts",
      description:
        "session.ts 只保留 message/metadata entry、store、JSONL recovery 与 active-path projection 的完整公共签名，以及 Lab 10.1–10.6 的明确施工位；不包含运行时校验、路径、快照、队列、恢复或故障状态机。",
    },
  ],
  "11": [
    {
      source: "starters/11-session.ts",
      destination: "src/session.ts",
      description:
        "session.ts 保留 Chapter 10 的完整 session tree 与 fail-closed JSONL，只增加严格 compaction 类型，并把 Lab 11.1 的 compaction 解析施工位留空。",
    },
    {
      source: "starters/11-context.ts",
      destination: "src/context.ts",
      description:
        "context.ts 固定 interaction、预算投影与纯 compaction 创建的最小公共签名，并为 Lab 11.2–11.5 保留各自的明确施工位。",
    },
  ],
  "12": [
    {
      source: "starters/12-resources.ts",
      destination: "src/resources.ts",
      description:
        "resources.ts 只保留资源目录、按需激活、模板上下文和扩展宿主的公共签名，以及 Lab 12.1–12.5 的明确施工位；不包含 precedence、realpath containment、原子注册或 hook 隔离算法。",
    },
  ],
  "13": [
    {
      source: "starters/13-composition.ts",
      destination: "src/composition.ts",
      description:
        "composition.ts 保留 Runtime 配置、依赖、控制面、context adapter 与 mode 的公共签名，并提供一个 prompt/flush/dispose 明确停在 Lab 13.3 的 RuntimeImpl 外壳；不包含恢复、投影、持久化队列、poison 或生命周期算法。",
    },
  ],
  "14": [
    {
      source: "starters/14-eval.ts",
      destination: "test-support/eval.ts",
      description:
        "eval.ts 固定 case、observation、verdict、report 与 runner 的完整公共表面；只保留 Lab 14.1 和 Lab 14.3 的明确施工位，不包含协议校验、失败分层、证据脱敏或 cleanup 算法。",
    },
    {
      source: "starters/14-tsconfig.json",
      destination: "tsconfig.json",
      description:
        "tsconfig.json 只增加 test-support 的编译入口，让 Chapter 13 parent 加上本章脚手架后可以先通过 build。",
    },
  ],
};

if (!requested || !/^\d{2}$/.test(requested)) {
  process.stderr.write(
    "用法：npm run practice -w @pi/course -- <00..14> [输出目录]\n",
  );
  process.exit(1);
}

const rows = execFileSync(
  "git",
  [
    "log",
    "--reverse",
    "--format=%H%x09%P%x09%s",
    "--",
    "packages/pi-course",
  ],
  { cwd: repoRoot, encoding: "utf8" },
)
  .trim()
  .split("\n")
  .map((line) => {
    const [commit, parents, subject] = line.split("\t");
    return { commit, parent: parents.split(" ")[0], subject };
  });
const row = rows.find(({ subject }) =>
  subject.startsWith(`course(${requested}):`),
);

if (!row) {
  process.stderr.write(`找不到 checkpoint ${requested}\n`);
  process.exit(1);
}

const output = process.argv[3]
  ? path.resolve(repoRoot, process.argv[3])
  : path.resolve(repoRoot, "..", `pi-practice-${requested}`);

if (
  output === repoRoot ||
  output.startsWith(`${repoRoot}${path.sep}`)
) {
  process.stderr.write("练习目录必须位于 Pi 仓库之外\n");
  process.exit(1);
}
if (existsSync(output)) {
  process.stderr.write(`练习目录已存在：${output}\n`);
  process.exit(1);
}

const mode = requested === "00" ? "观察" : "重建";
const snapshot = requested === "00" ? row.commit : row.parent;
const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-practice-"));
const archive = path.join(temporary, "snapshot.tar");
let createdOutput = false;

try {
  execFileSync(
    "git",
    [
      "archive",
      "--format=tar",
      `--output=${archive}`,
      snapshot,
      "package.json",
      "package-lock.json",
      "packages/pi-course",
    ],
    { cwd: repoRoot, stdio: "pipe" },
  );
  await mkdir(output, { recursive: false });
  createdOutput = true;
  execFileSync("tar", ["-xf", archive, "-C", output], {
    cwd: repoRoot,
    stdio: "pipe",
  });

  const rootPackagePath = path.join(output, "package.json");
  const rootPackageDocument = JSON.parse(
    await readFile(rootPackagePath, "utf8"),
  );
  if (rootPackageDocument.scripts) {
    delete rootPackageDocument.scripts.prepare;
  }
  await writeFile(
    rootPackagePath,
    `${JSON.stringify(rootPackageDocument, null, "\t")}\n`,
  );

  const testFiles = execFileSync(
    "git",
    [
      "ls-tree",
      "-r",
      "--name-only",
      row.commit,
      "packages/pi-course/test",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  )
    .trim()
    .split("\n");
  const focusedTest = testFiles.find((file) =>
    file.startsWith(`packages/pi-course/test/${requested}-`),
  );
  if (!focusedTest) {
    throw new Error(`checkpoint ${requested} 缺少聚焦测试`);
  }

  if (mode === "重建") {
    const targetTest = execFileSync(
      "git",
      ["show", `${row.commit}:${focusedTest}`],
      { cwd: repoRoot },
    );
    const destination = path.join(output, focusedTest);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, targetTest);

    const currentGuide = execFileSync(
      "git",
      [
        "show",
        `${row.commit}:packages/pi-course/AGENT_GUIDE.md`,
      ],
      { cwd: repoRoot },
    );
    await writeFile(
      path.join(output, "packages/pi-course/AGENT_GUIDE.md"),
      currentGuide,
    );

    for (const overlay of starterOverlays[requested] ?? []) {
      const starter = await readFile(
        path.join(packageRoot, overlay.source),
      );
      const destination = path.join(
        output,
        "packages/pi-course",
        overlay.destination,
      );
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, starter);
    }
  }

  const packageDocument = JSON.parse(
    await readFile(path.join(output, "packages/pi-course/package.json"), "utf8"),
  );
  const packageName = packageDocument.name;
  const overlays = starterOverlays[requested] ?? [];
  const scaffoldNote =
    overlays.length === 0
      ? ""
      : `\n本章另有学习脚手架：\n${overlays
          .map(
            ({ destination, description }) =>
              `- \`packages/pi-course/${destination}\`：${description}`,
          )
          .join("\n")}\n\n脚手架不属于 parent，也不是完整 target。先保留公共表面，让每段局部测试都能编译；你仍要亲自实现本章核心行为。\n`;
  const guide = `# Chapter ${requested} 隔离练习

模式：${mode}

- parent（本章起点）：\`${row.parent}\`
- target（测试通过的终点）：\`${row.commit}\`
- 当前快照：\`${snapshot}\`
- 聚焦测试：\`${focusedTest}\`

这个目录没有额外 Git 历史或另一份答案可供偷看。${mode === "观察"
    ? "00 章已经处于 target，只做预测、运行和受控破坏，不重写实现。"
    : `当前源码来自 parent，并注入 target 的聚焦测试；先让它红，再逐步实现。${scaffoldNote}`}

第一次运行：

\`\`\`bash
npm install
npm run build -w ${packageName}
node --test packages/pi-course/dist/test/${requested}-*.test.js
\`\`\`

若主仓库已经安装依赖，可由陪练安全地复用依赖目录；不要把参考实现复制进来。
`;
  await writeFile(path.join(output, "LEARNING.md"), guide);

  process.stdout.write(
    [
      `chapter: ${requested}`,
      `mode:    ${mode}`,
      `output:  ${output}`,
      `test:    ${focusedTest}`,
      "",
      `先阅读 ${path.join(output, "LEARNING.md")}`,
      "",
    ].join("\n"),
  );
} catch (error) {
  if (createdOutput) {
    await rm(output, { recursive: true, force: true });
  }
  throw error;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
