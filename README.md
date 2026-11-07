# GapGraph 缺口图谱

备考者的「掌握度可视化 + 每日补习计划」桌面软件。Electron + TypeScript，纯本地运行，断网可用。

> 设计依据：`docs/gapgraph-功能设计报告.md`（技术规格）、`docs/gapgraph-功能说明-通俗版.md`（产品说明）、`docs/graph-radial.html`（可视化定稿）。

## 快速开始

**浏览器版（当前机器可用，推荐先用它看效果）**

```bash
npm run dev:web      # 或双击 start-web.cmd，浏览器自动打开 http://localhost:5180
```

**桌面版（Electron）**

```bash
npm run dev          # 或双击 start-dev.cmd
```

> 当前这台机器上 Electron 起不来：`electron.exe --version` 不加 `--no-sandbox` 直接退出（0x80000003），
> 加参数后一建窗口就 0xC0000005 崩溃；换 Electron 40 同样崩，而系统 Edge（同为 Chromium 内核）能正常开窗，
> Electron 自带的最小示例也崩 —— 与本项目代码无关，是运行环境问题。
> 比赛现场换机器大概率正常，期间用浏览器版即可完整使用产品。

**其他命令**

```bash
npm test             # 67 条领域单测
npm run typecheck    # 主进程 + 渲染进程类型检查
npm run build        # 产出 Electron 三端 out/
npm run build:web    # 产出浏览器版 out/web/
```

## 演示保底方案（推荐现场用这个）

```bash
npm run build:web
# 然后双击 out/web/index.html
```

构建出来的 `out/web/` 是**自包含**的：单文件 IIFE 脚本、样式内联、相对路径。

- 不依赖 Node.js、不依赖本地服务器、不依赖网络
- 可以直接拷到 U 盘，在任何装了 Chrome/Edge 的电脑上双击打开
- 在 `file://` 下 localStorage 可用，数据能存住（已实测：答题→错因→落盘全通）

Electron 版本保留给"装得了的环境"用；演示现场**优先用这个**。

## 已经能跑通的链路

选考纲 → 环形知识地图 → 点节点看讲解/自评 → 做题 → 该考点颜色变化 → 生成明天要做的事。

- **考纲骨架**：`resources/packs/gaokao-math-function.json`，42 个节点，含前置依赖、易混配对、考频权重、**每条关系的理由**
- **题库**：`resources/questions/gaokao-math-function.json`，30 道题，覆盖高权重考点
- **诊断摸底**：12–15 道自适应题，答错自动下钻前置考点，测完给出"最薄的三处"
- **掌握度模型**：覆盖 ×（0.6×能力 + 0.4×记忆保持），带可信度与保守收缩
- **缺口优先级**：`考频 × (1−掌握) × 前置闸门 × 错误概念加成 × 抢分系数`
- **今日队列**：到期复习 ≤2 张 + 缺口补救 1 张，总时长不超过上限，装不下就少给

> 想直接进摸底：地址后加 `#diag`（如 `http://localhost:5180/#diag`），演示时方便。

## 两种运行方式共用一套代码

| | 桌面版 | 浏览器版 |
|---|---|---|
| 界面 | `src/renderer` | 同一份 |
| 领域算法 | `src/shared` + `src/main/domain` | 同一份 |
| 数据 | 主进程读写 `.data/data/state.json` | `localStorage` |
| 入口 | `src/preload` 暴露 `window.api` | `src/renderer/src/local-api.ts` 顶替 |

`app.ts` 里只有一行判断：有 `window.api` 就用它，没有就退回本地实现。

## 目录

```
src/
  shared/         类型 + 掌握度公式（主进程与渲染进程共用同一份）
  main/
    index.ts      窗口、IPC 白名单
    service.ts    读写状态、判分、更新掌握度
    domain/       纯函数：mastery / priority / queue / grading（可单测）
  preload/        只暴露 6 个动作，渲染进程拿不到 fs
  renderer/
    src/graph.ts    环形图渲染（极坐标树 + 螺旋连线 + 折叠第三层）
    src/app.ts      界面与交互
    src/local-api.ts 浏览器模式的数据层
resources/        考纲包、题库
tests/            36 条单测
docs/             设计报告与可视化原型
```

## 发版清单（每次改完必做）

用户第一次进入、以及**每次版本变化后**，都会看到一份使用指南；指南和版本号是绑死的。

1. 改 `src/renderer/src/guide.ts` 的 `GUIDE_STEPS` / `GUIDE_RULES`，把新功能写进去
2. 在 `GUIDE_RELEASES` 顶部加一条本次更新（版本号 + 日期 + 改动列表）
3. `GUIDE_VERSION` 与 `package.json` 的 `version` 同时升
4. `npm test` —— 版本号不一致、或最新更新条目为空，测试会直接失败

这套约束写在 `tests/guide.test.ts` 里，不靠自觉。

## 数据

- 桌面版：`项目根/.data/data/state.json`（已 gitignore），删掉即重置
- 浏览器版：清空站点数据即重置
- 使用指南的"已读版本"存在 `localStorage` 的 `gapgraph.guide.seen`

## 已知边界（v0.2.0）

- 只做了一个板块（函数）的一科内容；换学科是替换 `resources/` 里的两个 JSON
- 错因归因（F7）、AI 讲解与卡片（F9）、题源导入（F11）尚未接入
- 每个考点固定给 3 道题，尚未做单点自适应练习（摸底已经是自适应的）
- 存储用 JSON 文件（桌面版）与 localStorage（浏览器版），未上 SQLite；表结构已在设计文档里规划好
- 未做 electron-builder 打包
