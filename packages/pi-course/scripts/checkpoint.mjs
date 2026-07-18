import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(packageRoot, "..", "..");
const requested = process.argv[2]?.padStart(2, "0");

if (!requested || !/^\d{2}$/.test(requested)) {
  process.stderr.write(
    "用法：npm run checkpoint -w @pi/course -- <00..14>\n",
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

process.stdout.write(
  [
    `checkpoint: ${requested}`,
    `target:     ${row.commit}`,
    `parent:     ${row.parent}`,
    `subject:    ${row.subject}`,
    "",
    "先让学习者预测，再查看：",
    `git diff ${row.parent} ${row.commit} -- packages/pi-course`,
    "",
    "聚焦运行：",
    `node --test packages/pi-course/dist/test/${requested}-*.test.js`,
    "",
  ].join("\n"),
);
