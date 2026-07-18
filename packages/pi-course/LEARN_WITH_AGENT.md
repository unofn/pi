# 和陪学 Agent 一起走这条 commit 历史

这条分支的单位不是“文件”，而是“学习状态转换”。每个 `course(00)`～
`course(14)` commit 的 parent 是起点，commit 自身是经过测试的目标。

## 每章固定对话

先在保持 `course/build-your-own-pi` HEAD 的教学 worktree 中创建无答案练习目录：

```bash
npm run practice -w @pi/course -- <NN>
```

00 会导出可直接观察的 target；01～14 以本章 parent 为起点，并额外放入
target 的聚焦测试。少数代码量陡增的章节还会加入 learning-only scaffold：
它只保留公共表面和显式未实现分支，不包含 target 的核心算法。`LEARNING.md`
会逐项披露这些额外文件。练习目录没有 Git 历史，因此学生不能意外看到完整答案。
`checkpoint` 只负责解释起点、终点和 diff 命令；`practice` 才负责创建可以动手
和运行聚焦测试的隔离目录。

把下面这段交给陪学 Agent，并把 `<NN>` 换成章节号：

```text
我们正在学习“造一个 Pi”的第 <NN> 章。
请先运行 npm run checkpoint -w @pi/course -- <NN>，
再运行 npm run practice -w @pi/course -- <NN>，
阅读输出中的 target commit、它的 parent、隔离目录中的 LEARNING.md、
packages/pi-course/AGENT_GUIDE.md 对应章节，以及教材正文。

不要直接给我完整答案。先问我对下一次测试输出的预测，然后一次只给一个动作。
如果我卡住，按“定位文件 → 指出签名 → 给伪代码 → 给局部代码”的顺序逐级提示。
每完成一个动作就让我运行聚焦测试，并问我第一次偏差属于哪一层。
```

## 为什么 Agent 必须看 parent

最终分支已经包含后续章节。若 Agent 只看 HEAD，它会用未来抽象解释当前问题，
让你以为自己本该一步写出最终架构。对比 parent 与 target 后，它只能使用本章
已经建立的词汇和接口。

## 迁移不是第一次学习的门槛

先在提示下把主链路重建一遍，形成正确的状态、所有权和失败 schema。之后再：

1. 隔一天不看 diff 重做本章核心；
2. 只允许 Agent 给到伪代码；
3. 最后尝试教材里的可选迁移情境。

这叫支架渐隐，不是“看完讲解后立刻独立从空白写出”。
