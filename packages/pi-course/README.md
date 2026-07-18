# 造一个 Pi · commit 教材

这不是上游实现的缩写版，而是一条为学习设计的累积历史。分支
`course/build-your-own-pi` 从 Pi 上游固定提交 `8479bd84` 出发；章节
00～14 各对应一个可检出、可测试的 commit。

## 怎么跟着学

1. 在教材页面读本章，只先写“我预测会发生什么”。
2. 让陪学 Agent 阅读本文件、`AGENT_GUIDE.md`、本章 commit 与它的 parent。
3. Agent 先解释本章 diff 的责任边界，再一次只给一个动作，不直接粘贴整份答案。
4. 每个动作后运行 `npm test -w @pi/course` 或本章指定的聚焦测试。
5. 你能解释首次失败属于哪一层后，再进入下一章。

先创建不会暴露 target 实现的练习目录：

```bash
npm run practice -w @pi/course -- 01
```

00 会导出 target 供观察；01～14 以 parent 为起点，并注入本章聚焦测试。代码量
陡增的章节还会披露一个 learning-only scaffold；它只让分段实验能够编译，不包含
核心状态机。命令拒绝覆盖已存在目录，默认把练习放在 Pi 仓库旁边。

查看累积历史：

```bash
git log --reverse --oneline -- packages/pi-course
```

查看某一章到底增加了什么：

```bash
git show --stat <本章提交>
git diff <本章提交>^ <本章提交> -- packages/pi-course
```

`迁移练习` 是掌握后的可选挑战，不是第一次学习的放行条件。
