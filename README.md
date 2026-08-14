# dsh-agent-book

[![npm version](https://img.shields.io/npm/v/@dingyi222666/dsh-agent-book.svg)](https://www.npmjs.com/package/@dingyi222666/dsh-agent-book)

English | [中文](README.zh.md)

A plugin for dsh that brings opencode-style custom agents to your conversations. You define agents as markdown files — each with its own system prompt and model — and then call them from chat with an `@mention`. The mention dispatches a subagent running under that agent's instructions and model, and the agent's reply comes back into the conversation as context.

## How it works

Drop one file per agent into the agents directory (default `~/.dsh/agents/`). The file name becomes the mention name; the YAML frontmatter carries the `description` (shown in the `@` menu and to the model) and an optional `model`; the body is the agent's system prompt.

```md
---
description: Reviews code for bugs and edge cases
model: deepseek-chat
---
You are a senior code reviewer. Check for correctness, edge cases, and
security issues. Explain each finding and suggest a fix.
```

Then type `@reviewer <your request>` in any conversation:

- The `@` menu (same trigger the built-in subagent reference uses) lists your agents with their descriptions — pick one and the mention lands in the draft as `@name `.
- When the message is sent, the harness routes the request deterministically: the rest of the message becomes the task, the agent's body becomes the child's system prompt, and the frontmatter `model` (when present) becomes the child's model. The child runs on the subagent provider (`spawn` by default), so you can see it in the subagent catalog while it works.
- The agent's reply is appended to the step as a context notice (`@reviewer returned`), so the main model sees the result and continues.

```sh
# In chat
@reviewer 检查这段代码有没有 bug

# The main agent then sees, in context:
#   The user's @reviewer mention was dispatched to the "reviewer" agent
#   (model deepseek-chat). The agent's reply:
#   ...
```

## Install

```sh
# Install from npm (requires dsh >= 0.1.0-rc.6)
dsh plugin --profile web add @dingyi222666/dsh-agent-book
# Restart dsh web; the '@' agent source mounts automatically
dsh web
```

Notes:

- `dsh plugin` behaves like adding a dependency to your web profile. A bundle plugin is loaded once its full package name appears in the profile's `dsh.profile.bundles` list (adds automatically on recent dsh builds; add it manually if your build does not); the bundle patch applies on the next boot.
- With the repo source-launched CLI, run the args through the bin directly (`node --import tsx/esm apps/cli/src/bin.ts ...`).

## Configuration

The plugin row accepts the usual cordis config keys (set them in your profile's `cordis.patch.yml` under the `dsh-agent-book` row's `config`, or with `!!js` expressions where needed):

| Key | Default | Meaning |
| --- | --- | --- |
| `agentsDir` | `~/.dsh/agents` | Directory holding one `*.md` agent definition per file |
| `provider` | `spawn` | Subagent provider name; must support the `persona` capability |
| `maxDepth` | `3` | Absolute delegation-depth cap for dispatched agents (`0` forbids dispatch) |
| `rosterPath` | `/dsh-agent-book/agents.json` | HTTP path of the browser roster endpoint |

## Model Experience

- **Added prompt content**: one system-prompt section (order 95) listing the loaded agents (`@name — description (model: …)`), plus, per dispatched mention, one user-role context notice carrying the agent's reply. Empty roster → the section renders nothing.
- **Added tools**: none — dispatch is deterministic in the pre-step, so the model never has to decide whether to delegate.
- **Token costs**: the roster section is proportional to the number of agents; each dispatch costs the child's own turn and one context notice.

## What's missing

- **First mention wins.** A message naming several agents dispatches only the first (longest-name-first) match; the rest of the message still goes to it as the task. Pick one agent per message for now.
- **Strict `{{…}}` persona rule.** The agent body is used as the child's persona, where `{{name}}` is a strict prompt-variable reference. A file whose body contains a complete `{{...}}` group is skipped at load with a logged reason — a lone `{{` without a later `}}` is fine. This matches dsh's own deployment-persona semantics.
- **Only `description` and `model` in frontmatter.** opencode's `temperature`, `mode`, and `tools` fields are not honored (dsh's subagent request has no temperature channel, and tool scoping is a separate capability).
- **No live reload.** Agent files are read at plugin load; editing them requires restarting the profile (HMR of the plugin fiber re-reads them).
- **Mention boundary is name characters only.** `@types/react` matches an agent literally named `types` — pick distinctive names.

## Development

- `yarn run build` — builds the browser bundle (`lib/client.js`) and the Node half (`lib/index.js` + `lib/invariant.js`).
- `yarn test` — vitest suite: agent parsing, mention detection, dispatch orchestration, the real apply path, and the browser `@` source.
- `yarn typecheck` — strict TypeScript over `src` and `tests`.
