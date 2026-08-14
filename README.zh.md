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
- 消息发出后由 harness 确定性路由：消息其余部分作为任务，agent 正文作为子代理的 system prompt，frontmatter 里的 `provider`/`model`（如有）作为子代理的路由。子代理跑在 subagent provider 上（默认 `spawn`），继承父代理的工具集——`@` 只是注入提示词，具体干活由子代理模型自己调工具完成；运行期间可以在 subagent 目录里看到它。
- agent 的回复以一条上下文通知（`@reviewer returned`）追加到这一步，主模型看到结果后继续。

```sh
# 对话中输入
@reviewer 检查这段代码有没有 bug

# 主模型随后在上下文中看到：
#   The user's @reviewer mention was dispatched to the "reviewer" agent
#   (google/gemini-3-flash-preview). The agent's reply:
#   ...
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

- **新增 prompt 内容**：一条 system-prompt section（顺序 95），列出已加载的 agent（`@name — description (model: …)`）；每次派发再加一条携带 agent 回复的 user 角色上下文通知。roster 为空时该 section 不渲染任何内容。
- **新增工具**：无——派发在 pre-step 里确定性完成，模型不需要决定是否委派。
- **Token 开销**：roster section 与 agent 数量成正比；每次派发消耗子代理自己的一轮和一条上下文通知。

## 已知限制

- **第一个 mention 生效。** 一条消息里提到多个 agent 时只派发第一个（按名字从长到短匹配），其余文本仍作为它的任务。目前请一条消息只叫一个 agent。
- **严格的 `{{…}}` persona 规则。** agent 正文会用作子代理的 persona，其中 `{{name}}` 是严格的 prompt 变量引用。正文含完整 `{{...}}` 组的文件会在加载时被跳过并记录原因（只有 `{{` 没有后续 `}}` 的字面文本没问题）。这与 dsh 自身的部署 persona 语义一致。
- **frontmatter 只支持 `description`、`provider` 和 `model`。** opencode 的 `temperature`、`mode`、`tools` 字段不生效（dsh 的 subagent 请求没有 temperature 通道，工具限定是另一个独立能力）。
- **不支持热重载。** agent 文件在插件加载时读取；改动后需重启 profile（插件的 HMR 重跑会重新读取）。
- **mention 边界只看名字字符。** 字面名为 `types` 的 agent 会被 `@types/react` 匹配到——请起有区分度的名字。

## 开发

- `yarn run build` — 构建浏览器 bundle（`lib/client.js`）和 Node 半边（`lib/index.js` + `lib/invariant.js`）。
- `yarn test` — vitest 套件：agent 解析、mention 检测、派发编排、真实 apply 路径、浏览器 `@` 源。
- `yarn typecheck` — 对 `src` 和 `tests` 做严格 TypeScript 检查。
