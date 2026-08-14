# dsh-agent-book

[![npm version](https://img.shields.io/npm/v/@dingyi222666/dsh-agent-book.svg)](https://www.npmjs.com/package/@dingyi222666/dsh-agent-book)

[English](README.md) | 中文

一个给 dsh 用的插件，把 opencode 式的自定义 agent 带进你的会话。用 markdown 文件定义 agent——每个文件有自己的 system prompt 和模型——然后在对话里用 `@名字` 呼叫它：该 mention 会派发一个 subagent，按这个 agent 的指令和模型运行，agent 的回复作为上下文回到对话里。

## 工作原理

在 agents 目录（默认 `~/.dsh/agents/`）里每个 agent 放一个文件。文件名就是 mention 名字；YAML frontmatter 放 `description`（显示在 `@` 菜单和模型视角里）、可选的 `provider` 和可选的 `model`；正文就是这个 agent 的 system prompt。

```md
---
description: 检查代码 bug 和边界情况
provider: google
model: gemini-3-flash-preview
---
你是一位资深代码评审员。检查正确性、边界情况和安全问题，逐条说明问题并给出修改建议。
```

`provider` 和 `model` 就是 dsh 自己的模型路由用的名字——即 Models 页面（或 `settings.yaml` 里的 `llm-*` 配置）里配置的那套。两个都省略则继承父代理的路由。路由缺失或不存在会导致子代理第一次请求失败，所以请用你配置的 provider 实际支持的 id。

然后在任意会话里输入 `@reviewer <你的请求>`：

- `@` 菜单（和内置 subagent 引用共用一个触发键）列出你的 agent 和描述——选中后以 `@名字 ` 落进输入框。
- 主模型从系统提示词里读到 roster，当请求提到某个 agent 时，**由主模型自己调用 `call_agent` 工具**（传 agent 名和任务）。工具把该 agent 作为子代理跑在 subagent provider 上（默认 `spawn`）：agent 正文作为子代理的 system prompt，frontmatter 里的 `provider`/`model` 作为子代理的路由，子代理继承父代理的工具集——agent 自己调工具干活。运行期间可以在 subagent 目录里看到它。
- 工具把 agent 的回复返回给主模型，主模型据此继续。

```sh
# 对话中输入
@reviewer 检查这段代码有没有 bug

# 主模型调用 call_agent(agent: "reviewer", prompt: "检查这段代码有没有 bug")
# 并从工具结果收到 agent 的回复。
```

## 安装

```sh
# 从 npm 安装（需要 dsh >= 0.1.0-rc.6）
dsh plugin --profile web add @dingyi222666/dsh-agent-book
# 重启 dsh web，'@' agent 引用源会自动挂载
dsh web
```

注意：

- `dsh plugin` 相当于给 web profile 加一个依赖。bundle 插件只有在完整包名出现在 profile 的 `dsh.profile.bundles` 列表后才会被加载（新版 dsh 会自动添加；旧版需手动加）；bundle patch 在下次启动时生效。
- 用仓库源码启动的 CLI 时，参数要直接走 bin（`node --import tsx/esm apps/cli/src/bin.ts ...`）。

## 配置

插件行接受常规的 cordis 配置键（在 profile 的 `cordis.patch.yml` 里 `dsh-agent-book` 行的 `config` 下设置，需要表达式时用 `!!js`）：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `agentsDir` | `~/.dsh/agents` | 存放 agent 定义（每个文件一个 `*.md`）的目录 |
| `provider` | `spawn` | subagent provider 名；必须支持 `persona` 能力 |
| `maxDepth` | `3` | 派发的 agent 的绝对委派深度上限（`0` 禁止派发） |
| `rosterPath` | `/dsh-agent-book/agents.json` | 浏览器 roster 端点的 HTTP 路径 |

## 模型体验

- **新增 prompt 内容**：一条 system-prompt section（顺序 95），列出已加载的 agent（`@name — description (路由)`），提示模型在请求提到某个 agent 时调用 `call_agent`。roster 为空时该 section 不渲染任何内容。
- **新增工具**：`call_agent`（仅在至少加载了一个 agent 时注册）——`agent`（roster 枚举）+ `prompt`。是否派发由模型决定。
- **Token 开销**：roster section 与 agent 数量成正比；每次派发消耗子代理自己的一轮。

## 已知限制

- **派发与否由模型决定。** 没有任何机制强制模型调用 `call_agent`；强模型可能直接回答 `@name` 请求而不派发。请把 roster 的 description 写清楚，帮助模型正确路由。
- **严格的 `{{…}}` persona 规则。** agent 正文会用作子代理的 persona，其中 `{{name}}` 是严格的 prompt 变量引用。正文含完整 `{{...}}` 组的文件会在加载时被跳过并记录原因（只有 `{{` 没有后续 `}}` 的字面文本没问题）。这与 dsh 自身的部署 persona 语义一致。
- **frontmatter 只支持 `description`、`provider` 和 `model`。** opencode 的 `temperature`、`mode`、`tools` 字段不生效（dsh 的 subagent 请求没有 temperature 通道，工具限定是另一个独立能力）。
- **支持热重载。** agents 目录会被监听：增删改 `*.md` 文件会自动重新注册 `call_agent` 工具的枚举并刷新 roster（约 200ms 防抖）——无需重启。修改已有 agent 的正文或路由，工具派发时立即用新定义。
- **mention 边界只看名字字符。** 字面名为 `types` 的 agent 会被 `@types/react` 匹配到——请起有区分度的名字。

## 开发

- `yarn run build` — 构建浏览器 bundle（`lib/client.js`）和 Node 半边（`lib/index.js` + `lib/invariant.js`）。
- `yarn test` — vitest 套件：agent 解析、mention 检测、派发编排、真实 apply 路径、浏览器 `@` 源。
- `yarn typecheck` — 对 `src` 和 `tests` 做严格 TypeScript 检查。
