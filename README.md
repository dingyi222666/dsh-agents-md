# dsh-agents-md

[![npm version](https://img.shields.io/npm/v/@dingyi222666/dsh-agents-md.svg)](https://www.npmjs.com/package/@dingyi222666/dsh-agents-md)

English | [中文](README.zh.md)

A plugin for dsh that brings opencode-style custom agents to your conversations. You define agents as markdown files — each with its own system prompt and model — and then call them from chat with an `@mention`. The mention dispatches a subagent running under that agent's instructions and model, and the agent's reply comes back into the conversation as context.

## How it works

Drop one file per agent into the agents directory (default `~/.dsh/agents/`). The file name becomes the mention name; the YAML frontmatter carries the `description` (shown in the `@` menu and to the model), an optional `provider`, and an optional `model`; the body is the agent's system prompt.

```md
---
description: Reviews code for bugs and edge cases
provider: google
model: gemini-3-flash-preview
---
You are a senior code reviewer. Check for correctness, edge cases, and
security issues. Explain each finding and suggest a fix.
```

`provider` and `model` are the names dsh's own model routing uses — the ones your Models page (or a `settings.yaml` `llm-*` section) configures. Omit both to inherit the parent agent's route. A missing or unknown route fails the child's first request, so use ids your configured providers actually advertise.

Then type `@reviewer <your request>` in any conversation:

- The `@` menu (same trigger the built-in subagent reference uses) lists your agents with their descriptions — pick one and the mention lands in the draft as `@name `.
- The main model reads the roster from its system prompt and, when a request names one of the agents, calls the `call_agent` tool itself with the agent's name and the task. The tool runs the agent as a subagent on the subagent provider (`spawn` by default): the agent's body becomes the child's system prompt, the frontmatter `provider`/`model` become the child's route, and the child inherits the parent's tool set — so the agent can call tools itself to do the work. You can watch it in the subagent catalog while it runs.
- The tool returns the agent's reply to the main model, which continues with it.

```sh
# In chat
@reviewer 检查这段代码有没有 bug

# The main model calls call_agent(agent: "reviewer", prompt: "检查这段代码有没有 bug")
# and receives the agent's reply from the tool result.
```

## Install

```sh
# Install from npm (requires dsh >= 0.1.0-rc.6)
dsh plugin --profile web add @dingyi222666/dsh-agents-md
# Restart dsh web; the '@' agent source mounts automatically
dsh web
```

Notes:

- `dsh plugin` behaves like adding a dependency to your web profile. A bundle plugin is loaded once its full package name appears in the profile's `dsh.profile.bundles` list (adds automatically on recent dsh builds; add it manually if your build does not); the bundle patch applies on the next boot.
- With the repo source-launched CLI, run the args through the bin directly (`node --import tsx/esm apps/cli/src/bin.ts ...`).

## Configuration

The plugin row accepts the usual cordis config keys (set them in your profile's `cordis.patch.yml` under the `dsh-agents-md` row's `config`, or with `!!js` expressions where needed):

| Key | Default | Meaning |
| --- | --- | --- |
| `agentsDir` | `~/.dsh/agents` | Directory holding one `*.md` agent definition per file |
| `provider` | `spawn` | Subagent provider name; must support the `persona` capability |
| `maxDepth` | `3` | Absolute delegation-depth cap for dispatched agents (`0` forbids dispatch) |
| `rosterPath` | `/dsh-agents-md/agents.json` | HTTP path of the browser roster endpoint |

## Model Experience

- **Added prompt content**: one system-prompt section (order 95) listing the loaded agents (`@name — description (route)`), telling the model to call `call_agent` when a request names one. Empty roster → the section renders nothing.
- **Added tools**: `call_agent` (registered only when at least one agent is loaded) — `agent` (enum of the roster) + `prompt`. The model decides when to dispatch.
- **Token costs**: the roster section is proportional to the number of agents; each dispatch costs the child's own turn.

## What's missing

- **The model decides when to dispatch.** Nothing forces a `call_agent` call; a strong model may answer a `@name` request directly. Keep the roster descriptions precise so the model routes correctly.
- **Strict `{{…}}` persona rule.** The agent body is used as the child's persona, where `{{name}}` is a strict prompt-variable reference. A file whose body contains a complete `{{...}}` group is skipped at load with a logged reason — a lone `{{` without a later `}}` is fine. This matches dsh's own deployment-persona semantics.
- **Only `description`, `provider`, and `model` in frontmatter.** opencode's `temperature`, `mode`, and `tools` fields are not honored (dsh's subagent request has no temperature channel, and tool scoping is a separate capability).
- **Live reload.** The agents directory is watched: adding, editing, or removing an `*.md` file re-registers the `call_agent` tool's enum and refreshes the roster section automatically (debounced ~200 ms) — no restart needed. Editing the body or route of an existing agent updates the definitions the tool dispatches immediately.
- **Mention boundary is name characters only.** `@types/react` matches an agent literally named `types` — pick distinctive names.

## Development

- `yarn run build` — builds the browser bundle (`lib/client.js`) and the Node half (`lib/index.js` + `lib/invariant.js`).
- `yarn test` — vitest suite: agent parsing, mention detection, dispatch orchestration, the real apply path, and the browser `@` source.
- `yarn typecheck` — strict TypeScript over `src` and `tests`.
