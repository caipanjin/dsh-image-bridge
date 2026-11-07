# dsh-image-bridge

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/)

Read images through a **dedicated vision subagent** whose model is configured
independently of the main agent's model.

Many text-first models (and any route the LLM runtime declares as text-only)
cannot see pixels: the runtime projects every image block to placeholder text
before the request leaves the process. This plugin gives such an agent a tool
that looks at the image for it.

## What it does

- Registers one model-facing tool, `recognize_image` by default.
- On a call it resolves the images the model pointed at (file paths, image
  attachment ids, or the most recent image already in the conversation),
  stores them through the Harness attachment service, and starts a child agent
  under `ctx.subagents`.
- The child runs on **its own** `provider`/`model` from this plugin's config —
  never the parent's — with the images plus the caller's question, and its
  answer comes back as plain text for the main model to use.
- The child runs at `maxDepth: 1` (it cannot spawn further agents of its own), runs
  with `delivery: 'caller'` (no completion notice leaks into the main
  conversation), and is always disposed after one question.
- While enabled, a short system-prompt line tells the main model that this tool
  exists, so a model whose runtime strips images knows to route them here.

## Configuration

Set these in the profile's `cordis.patch.yml` entry `vision-bridge`, or edit the
`*`-marked fields live from the Settings UI.

| Field | Default | Meaning |
|---|---|---|
| `provider` | (required) | Child model provider id, e.g. `openai`, `deepseek`, `magpie`. |
| `model` | (required) | Child vision model id on that provider, e.g. `gpt-4o-mini`, `qwen-vl-max`. |
| `reasoningEffort`* | `''` | Child-route reasoning effort id; empty uses the model default. |
| `maxTokens`* | `4096` | Output cap per child call. |
| `subagentProvider` | `spawn` | Backend on `ctx.subagents`; `spawn` ships with dsh base. |
| `subagentLabel` | `vision` | Label shown for each vision child. |
| `toolName` | `recognize_image` | Model-facing tool name. |
| `maxDepth` | `1` | Absolute delegation-depth cap; a child of the main agent is depth 1, so `1` admits the vision child but denies it grandchildren. |
| `timeoutMs` | `180000` | Per-call timeout. |
| `systemPrompt`* | `''` | Replace the child's built-in analyst instruction. |
| `guideline`* | `true` | Add the "call this tool for images" prompt line. |

The bundled example patch points `provider`/`model` at a Magpie route
(`magpie` / `qwenwork-community/qwork-advanced`). Change them to whichever
route in your profile accepts image input.

## Tool arguments

- `question` (required) — what to answer from the image(s).
- `images` (optional) — image file paths (absolute or workspace-relative) or
  image attachment ids. Several images are compared in one call. Omit it to
  read the most recent image sent in the conversation.

## Installing

This package is published to npm as `dsh-image-bridge` and installed as a DSH
profile bundle:

```
dsh plugin --profile <profile> add dsh-image-bridge
```

or through the DSH plugin hub / plugin manager by package name. It ships
plain JavaScript (`lib/index.js`) and needs no build step.

Runtime packages (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`,
`@deepseek-ai/dsh-subagent`, `@deepseek-ai/schemastery`) are declared as
**peer dependencies** and supplied by the Harness installation at load time —
the profile's module resolver routes these bare specifiers to the packages
bundled inside the app, so this package ships with no `node_modules/` of its
own and stays tiny. Only the Harness needs to provide them; install nothing
extra.
