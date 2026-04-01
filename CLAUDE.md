# CLAUDE.md — 本仓库协作指南

面向在本仓库里改代码、跑构建或使用 AI 助手时的上下文说明。更完整的安装与功能列表见根目录 [README.md](README.md) 与 [FEATURES.md](FEATURES.md)。

## 项目是什么

这是 **free-code**：可构建的 Claude Code CLI 源码快照分支（终端里的 AI 编程代理）。技术栈与上游 Claude Code 一致：**Bun + TypeScript**，终端 UI 为 **React + Ink**。

本 fork 相对上游的典型差异（细节以 README 为准）：

- **遥测**：对外上报路径已剔除或桩实现。
- **安全类系统提示注入**：已移除 CLI 侧额外约束层（模型自身安全训练仍适用）。
- **实验功能**：通过编译期 `bun:bundle` 的 `feature('FLAG')` 与构建脚本 `--feature` / `--feature-set=dev-full` 打开；全量说明见 FEATURES.md。

## 环境

- **Bun** ≥ 1.3.11（`package.json` 的 `packageManager` / `engines`）
- macOS 或 Linux（Windows 建议 WSL）
- 运行需要 **Anthropic API**（`ANTHROPIC_API_KEY`）或按产品文档使用 OAuth 等登录方式

```bash
bun install
```

## 常用命令

| 命令 | 作用 |
|------|------|
| `bun run dev` | 从源码直接跑 CLI（`src/entrypoints/cli.tsx`），启动较慢，适合开发 |
| `bun run build` | 编译产物 `./cli`，默认仅启用部分特性（含 `VOICE_MODE`） |
| `bun run build:dev` | `./cli-dev`，开发版本号与相关 define |
| `bun run build:dev:full` | `./cli-dev`，启用 `scripts/build.ts` 里列出的整套实验特性集合 |
| `bun run compile` | 输出到 `./dist/cli` |
| 自定义特性 | `bun run ./scripts/build.ts --feature=FLAG` 或 `--dev --feature=...` |

构建入口脚本：[scripts/build.ts](scripts/build.ts)（`--feature-set=dev-full`、`--feature`、`--dev`、`--compile`、Bun `build` 参数与 `--define`）。

## 代码地图（从哪改起）

| 路径 | 说明 |
|------|------|
| [src/entrypoints/cli.tsx](src/entrypoints/cli.tsx) | CLI 入口；含 `--version` 快路径与动态 import；大量逻辑用 `feature()` 做编译期裁剪 |
| [src/commands.ts](src/commands.ts) | `/` 斜杠命令注册 |
| [src/tools.ts](src/tools.ts) | Agent 工具注册（Bash、Read、Edit 等） |
| [src/QueryEngine.ts](src/QueryEngine.ts) | 与模型交互的查询引擎 |
| [src/screens/REPL.tsx](src/screens/REPL.tsx) | 主交互界面 |
| [src/commands/](src/commands/) | 各斜杠命令实现 |
| [src/tools/](src/tools/) | 各工具实现 |
| [src/components/](src/components/) | Ink/React 终端组件 |
| [src/hooks/](src/hooks/) | React hooks |
| [src/services/](src/services/) | API 客户端、MCP、OAuth 等 |
| [src/state/](src/state/) | 应用状态 |
| [src/utils/](src/utils/) | 通用工具（体量大，改前先局部搜索） |
| [src/skills/](src/skills/) | Skill 系统 |
| [src/plugins/](src/plugins/) | 插件系统 |
| [src/bridge/](src/bridge/) | IDE 桥接（如 BRIDGE_MODE） |
| [src/voice/](src/voice/) | 语音相关 |
| [src/tasks/](src/tasks/) | 后台任务 |

路径别名：`tsconfig.json` 中 `baseUrl` + `paths` 的 `src/*` → 源码树。

## 实现约定（给改代码的人）

- **编译期特性**：源码里用 `import { feature } from 'bun:bundle'` 与 `feature('SOME_FLAG')`；未启用的分支会在构建时被 DCE 掉。新增或排查行为时对照 [FEATURES.md](FEATURES.md) 与 [scripts/build.ts](scripts/build.ts)。
- **TypeScript**：`strict` 未全开；`verbatimModuleSyntax`、`allowImportingTsExtensions` 等与 Bun 捆绑流程一致，新增文件时跟随现有文件的 import 风格。
- **UI**：终端内为 Ink 组件，避免假设浏览器 DOM。
- **测试**：当前 `package.json` 未定义统一测试脚本；以 `bun run build` / `bun run dev` 与手动场景为主。

## 许可与合规

上游源码权利归属见 README 中的说明；使用与分发请自行评估合规性。

## 文档索引

- [README.md](README.md) — 安装、构建变体、运行方式、技术栈表
- [FEATURES.md](FEATURES.md) — 全量 `feature()` 标志审计与构建说明
