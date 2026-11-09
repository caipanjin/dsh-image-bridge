/**
 * Vision bridge — read images through a dedicated, independently configured
 * vision subagent.
 *
 * When the main agent's model cannot see images, the LLM runtime projects every
 * image block to placeholder text before the request leaves the process, so the
 * main model genuinely cannot look at a screenshot, photo, chart, or scanned
 * page. This plugin registers one model-facing tool (`recognize_image` by
 * default) that:
 *
 *   1. resolves the caller's image references (paths, attachment ids, or the most
 *      recent image already in the conversation) to durable attachment blocks;
 *   2. starts a child Agent under `ctx.subagents` with its OWN provider/model —
 *      never the parent's — and a delegation depth that forbids further nesting;
 *   3. delivers the images plus the caller's question, waits for the child's
 *      answer, releases the child, and returns the answer as text.
 *
 * The child model is configured in this row (`provider` / `model`), so operators
 * can point image reading at any vision-capable route regardless of what the
 * main conversation uses. Runtime Harness packages (`@deepseek-ai/cordis`,
 * `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-subagent`) resolve from the
 * installation, so this package ships plain JavaScript with no build step.
 *
 * @module dsh-image-bridge
 */

import { readFile } from 'node:fs/promises';
import { defineTool } from '@deepseek-ai/dsh-tools';

/** Stable plugin name used by Loader diagnostics. */
export const name = 'vision-bridge';

/** Services this plugin needs before activating; without them it stays inactive. */
export const inject = ['tools', 'subagents'];

/** One line of guidance added to the system prompt when `guideline` is on. */
const GUIDELINE =
  'Images: this model cannot see image pixels. When a message, tool result, or file path refers to an image ' +
  '(screenshot, photo, diagram, chart, scanned document, UI mockup), call `{TOOL}` with that path (or the image ' +
  'attachment id) and a `question`, then answer from the text it returns. Never guess an image\'s content, ' +
  'describe an image from its filename alone, or claim you looked at it without that tool call. Pass several ' +
  'paths to compare images in one call.';

/** Default instruction sent to the vision child ahead of the caller's question. */
const DEFAULT_VISION_INSTRUCTION = [
  'You are a precise image analyst running as a subagent for a main agent that cannot see images.',
  'You receive one or more images and a question. Answer the question directly from what is visible.',
  'Be concrete: quote visible text verbatim (keep its language), read values and axis labels from charts, name UI',
  'elements and layout, and mention color or spatial relations only when they matter to the question.',
  'State uncertainty explicitly instead of guessing, and say so when something is unreadable or cut off.',
  'Do not use tools and do not write files. Respond with the answer text only.',
].join(' ');

/** Media types the attachment service accepts, keyed by the extension we sniff from a path. */
const IMAGE_EXTENSIONS = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
]);

/** Cap on the question text forwarded to the child. */
const MAX_QUESTION_CHARS = 8000;

/** Cap on one image forwarded to the child; the attachment service also enforces its own limit. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Default per-call timeout; image understanding on a remote model is slower than a file read. */
const DEFAULT_TIMEOUT_MS = 180000;

/**
 * Plugin configuration, declared as a JSON Schema. The Loader validates the
 * `config` of this plugin's patch row against it, and the settings subsystem
 * projects the `volatile: true` fields into an editable form (a committed value
 * reaches the running plugin through `ctx.fiber.entry`'s live reference, which
 * `live()` resolves at call time). Avoiding a schema library keeps this package
 * dependency-free apart from the Harness runtime itself.
 */
export const Config = {
  type: 'object',
  properties: {
    provider: {
      type: 'string',
      title: 'Vision provider',
      description: 'Child model route: provider id registered on ctx.llm (e.g. openai, anthropic, deepseek).',
    },
    model: {
      type: 'string',
      title: 'Vision model',
      description: 'Child model id on that provider (e.g. gpt-4o-mini, qwen-vl-max).',
    },
    reasoningEffort: {
      type: 'string',
      title: 'Reasoning effort',
      description: 'Adapter-owned reasoning effort id for the child route; empty uses the model default.',
      default: '',
      volatile: true,
    },
    maxTokens: {
      type: 'integer',
      title: 'Max output tokens',
      description: 'Output-token cap for each vision child call.',
      minimum: 1,
      default: 4096,
      volatile: true,
    },
    subagentProvider: {
      type: 'string',
      title: 'Subagent backend',
      description: 'Backend on ctx.subagents; "spawn" ships with the dsh base bundle.',
      default: 'spawn',
    },
    subagentLabel: {
      type: 'string',
      title: 'Child label',
      description: 'Short label recorded for each vision child session.',
      default: 'vision',
    },
    toolName: {
      type: 'string',
      title: 'Tool name',
      description: 'Model-facing tool name; keep it unique among the profile tools.',
      default: 'recognize_image',
    },
    maxDepth: {
      type: 'integer',
      title: 'Delegation depth cap',
      description:
        'Absolute delegation-depth cap for the child. A child of the main agent is depth 1, so 1 admits the ' +
        'vision child while denying it grandchildren; 0 rejects the child itself.',
      minimum: 0,
      default: 1,
    },
    timeoutMs: {
      type: 'integer',
      title: 'Timeout (ms)',
      description: 'Per-call wall-clock timeout in milliseconds.',
      minimum: 1000,
      default: DEFAULT_TIMEOUT_MS,
    },
    systemPrompt: {
      type: 'string',
      title: 'Child instruction',
      description: 'Replacement instruction sent to the child; empty uses the built-in analyst prompt.',
      default: '',
      volatile: true,
    },
    guideline: {
      type: 'boolean',
      title: 'Add tool guidance',
      description: 'Add the one-line "call this tool for images" guidance to the system prompt.',
      default: true,
      volatile: true,
    },
  },
  required: ['provider', 'model'],
};

/** Declared defaults, merged under a row's `config` so runtime reads are always concrete. */
const DEFAULTS = {
  provider: '',
  model: '',
  reasoningEffort: '',
  maxTokens: 4096,
  subagentProvider: 'spawn',
  subagentLabel: 'vision',
  toolName: 'recognize_image',
  maxDepth: 1,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  systemPrompt: '',
  guideline: true,
};

/** Read one config field that may be a live volatile reference. */
function live(value, fallback) {
  const resolved =
    value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
  return resolved === undefined || resolved === null || resolved === '' ? fallback : resolved;
}

/** Guess a media type from a file name; the attachment store verifies the real bytes. */
function sniffMediaType(fileName) {
  const extension = /\.([A-Za-z0-9]+)$/u.exec(fileName ?? '')?.[1]?.toLowerCase();
  return IMAGE_EXTENSIONS.get(extension) ?? 'image/png';
}

/** Whether a string looks like a filesystem path rather than an attachment id. */
function looksLikePath(value) {
  return /^(?:~|\/|\.{1,2}[\\/]|[A-Za-z]:[\\/])/u.test(value) || value.includes('/') || value.includes('\\');
}

/** Read one file the caller named and turn it into a durable image block. */
async function imageBlockFromPath(attachments, path) {
  const fileName = path.split(/[\\/]/u).pop();
  let bytes;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (error) {
    throw new Error(`cannot read image "${path}": ${error instanceof Error ? error.message : String(error)}`);
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`image "${path}" is larger than ${MAX_IMAGE_BYTES} bytes`);
  const attachment = await attachments.saveImage({
    data: bytes,
    mediaType: sniffMediaType(fileName),
    ...(fileName === undefined ? {} : { name: fileName }),
  });
  return { type: 'image', attachment };
}

/**
 * Resolve one model-typed image reference to an image content block.
 * Accepts an already-durable `{ attachment }` object, a `{ path }` or
 * `{ attachmentId }` object, an attachment id, or a path.
 */
async function imageBlock(attachments, reference) {
  if (reference !== null && typeof reference === 'object') {
    if (reference.type === 'image' && reference.attachment !== undefined) {
      return { type: 'image', attachment: { ...reference.attachment } };
    }
    if (typeof reference.attachmentId === 'string' && reference.attachmentId !== '') {
      return imageBlock(attachments, reference.attachmentId);
    }
    if (typeof reference.path === 'string' && reference.path !== '') {
      return imageBlock(attachments, reference.path);
    }
  }
  const value = String(reference ?? '').trim();
  if (value === '') throw new Error('empty image reference');
  if (attachments === undefined) throw new Error('the attachment service is unavailable in this profile');
  if (looksLikePath(value)) return imageBlockFromPath(attachments, value);
  if (/^[A-Za-z0-9_.:-]{8,200}$/u.test(value)) {
    try {
      const stored = await attachments.readImage({ attachmentId: value });
      return { type: 'image', attachment: stored.ref };
    } catch (error) {
      throw new Error(
        `"${value}" is neither a readable image path nor a known attachment id: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(`"${value}" is not an image path or attachment id`);
}

/** Image blocks carried by one message-like `{ content }` value, in order. */
function imagesOf(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.filter((block) => block !== null && typeof block === 'object' && block.type === 'image');
}

/**
 * Image blocks produced by one session event, newest sources first. A user may
 * send an image directly (`user/message`), and a tool — `read_image`, a
 * screenshot tool — may return one as its result (`tool/result.message`), which
 * is how most images reach the conversation in practice.
 */
function imagesOfEvent(event) {
  if (event?.type === 'user/message') return imagesOf(event.data);
  if (event?.type === 'tool/result') return imagesOf(event.data?.message ?? event.data);
  return [];
}

/**
 * The image most recently seen in the caller's conversation when the model omits
 * `images`: whatever it (or a tool) most recently put in front of the model.
 * @param session - the calling Agent's session.
 * @returns the newest image block, or undefined.
 */
function recentImage(session) {
  try {
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const images = imagesOfEvent(events[index]);
      if (images.length > 0) return images[images.length - 1];
    }
  } catch {
    // A session that cannot be read simply has no recent image.
  }
  return undefined;
}

/** Join the child's final assistant text blocks. */
function outputText(output) {
  const blocks = Array.isArray(output) ? output : [];
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * Build the child's prompt blocks. A single image is sent as-is; with several,
 * each image is preceded by an "Image N" label so the child can refer to them in
 * order when comparing. The trailing question block is always last.
 * @param images - resolved image content blocks.
 * @param instruction - the child's standing instruction.
 * @param question - the caller's question.
 */
function buildPrompt(images, instruction, question) {
  const labeled =
    images.length <= 1
      ? images
      : images.flatMap((image, index) => [
          { type: 'text', text: `Image ${index + 1}:` },
          image,
        ]);
  return [...labeled, { type: 'text', text: `${instruction}\n\nTask from the main agent: ${question}` }];
}

/**
 * Reject as soon as `signal` aborts, so a cancelled tool call stops waiting.
 * @param signal - caller cancellation.
 * @returns a promise that rejects on abort and has its listener removed on settle.
 */
function abortRace(signal) {
  if (signal === undefined) return { promise: new Promise(() => undefined), dispose: () => undefined };
  let onAbort;
  const promise = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('cancelled'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return { promise, dispose: () => signal.removeEventListener('abort', onAbort) };
}

/**
 * Run one recognition: start a vision child under the caller, wait for its
 * result, and always release it.
 * @param ctx - plugin context carrying `subagents` (and `attachments`).
 * @param config - the row's config.
 * @param request - validated arguments, the calling Agent, and its signal.
 * @returns the child's answer text.
 */
async function recognize(ctx, config, request) {
  const { args, agent, signal } = request;
  const attachments = ctx.get('attachments');
  const question = typeof args.question === 'string' ? args.question.trim() : '';
  if (question === '') throw new Error('question must not be empty');
  if (question.length > MAX_QUESTION_CHARS) throw new Error(`question is longer than ${MAX_QUESTION_CHARS} characters`);

  let images;
  if (Array.isArray(args.images) && args.images.length > 0) {
    images = await Promise.all(args.images.map((reference) => imageBlock(attachments, reference)));
  } else {
    const latest = recentImage(agent?.session);
    if (latest === undefined) {
      throw new Error(
        'No images to read: pass `images` with the path(s) of the image file(s), or send the image in the conversation first.',
      );
    }
    if (latest.offloaded === true) {
      throw new Error(
        `That image was offloaded by context compaction; pass its saved path as \`images\`.`,
      );
    }
    images = [latest];
  }

  const backendName = String(live(config.subagentProvider, 'spawn'));
  const backend = ctx.subagents.getProvider(backendName);
  if (backend === undefined) {
    throw new Error(`Vision bridge needs the "${backendName}" subagent backend, which is not mounted in this profile.`);
  }

  const providerId = String(live(config.provider, '') ?? '').trim();
  const modelId = String(live(config.model, '') ?? '').trim();
  if (providerId === '' || modelId === '') {
    throw new Error(
      'Vision bridge is not configured: set both `provider` and `model` for the vision subagent in this ' +
        'plugin\'s config (a route in your profile that accepts image input).',
    );
  }

  const effort = String(live(config.reasoningEffort, ''));
  const agentOptions = {
    provider: providerId,
    model: modelId,
    maxTokens: Number(live(config.maxTokens, 4096)),
    ...(effort === '' ? {} : { reasoningEffort: effort }),
  };
  const instruction = String(live(config.systemPrompt, DEFAULT_VISION_INSTRUCTION));

  let activation;
  try {
    activation = await ctx.subagents.startActivation({
      provider: backend.name,
      label: String(live(config.subagentLabel, 'vision')),
      request: {
        parent: agent,
        prompt: buildPrompt(images, instruction, question),
        agentOptions,
        maxDepth: Number(live(config.maxDepth, 1)),
      },
      signal,
      delivery: 'caller',
    });
  } catch (error) {
    throw new Error(`Could not start the vision subagent: ${error instanceof Error ? error.message : String(error)}`);
  }

  const timeoutMs = Number(live(config.timeoutMs, DEFAULT_TIMEOUT_MS));
  const abort = abortRace(signal);
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the vision subagent did not answer within ${timeoutMs} ms`)), timeoutMs);
    });
    const result = await Promise.race([activation.result, timeout, abort.promise]);
    const text = outputText(result?.output);
    if (result?.stopReason !== 'completed' && text === '') {
      throw new Error(
        `the vision subagent stopped with "${result?.stopReason}"${result?.diagnostic ? `: ${result.diagnostic}` : ''}`,
      );
    }
    return text === '' ? '(the vision subagent returned no text)' : text;
  } finally {
    clearTimeout(timer);
    abort.dispose();
    // Dispose settles the result; awaiting it releases the child and its slot.
    await activation.dispose().catch(() => undefined);
  }
}

/**
 * Mount the tool (and its prompt guidance) for the lifetime of this row.
 * @param ctx - Cordis context carrying `tools` and `subagents` (and optionally `attachments`, `systemPrompt`).
 * @param config - the row's config, validated by {@link Config}.
 */
export function apply(ctx, config) {
  // A JSON-Schema Config arrives the same way; merge declared defaults so the
  // rest of the plugin always sees concrete values. Volatile fields are read
  // through `live()` inside `recognize`, so a settings edit is picked up live.
  const cfg = config ?? {};
  config = { ...DEFAULTS, ...cfg };
  const toolName = String(live(config.toolName, 'recognize_image'));

  // Bind the tool only while its two services are present. `ctx.inject` keeps
  // this plugin (and the rest of the profile) alive in a composition that has
  // no `tools` or `subagents`, instead of throwing from `apply`.
  ctx.inject(['tools', 'subagents'], (toolCtx) => {
    toolCtx.effect(() =>
      toolCtx.tools.register(
      defineTool({
        name: toolName,
        description:
          'Read one or more images with a dedicated vision model and answer a question about them. Use it whenever ' +
          'the answer depends on what an image actually shows — screenshots, photos, diagrams, charts, scanned pages, ' +
          'UI mockups — especially when your own model cannot see images. Pass image paths from the conversation or ' +
          'workspace; omit `images` to read the most recent image sent in this conversation.',
        parameters: {
          question: {
            type: 'string',
            required: true,
            description:
              'The specific question to answer from the image(s), including any detail the answer must cover (verbatim text, values, layout, comparison).',
          },
          images: {
            type: 'array',
            items: {
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    path: { type: 'string' },
                    attachmentId: { type: 'string' },
                  },
                },
              ],
            },
            description:
              'Images to read. Each item is either a string (a file path — absolute or relative to the working ' +
              'directory — or an image attachment id) or an object { path } / { attachmentId }. Several images are ' +
              'compared against each other in one call, in the given order.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { text: { type: 'string', required: true } },
          },
          render: (_args, value) => [{ type: 'text', text: String(value.text ?? '') }],
        },
        timeoutMs: Number(live(config.timeoutMs, DEFAULT_TIMEOUT_MS)),
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          if (exec.agent === undefined) throw new Error('vision recognition requires a calling agent');
          const text = await recognize(toolCtx, config, { args, agent: exec.agent, signal: exec.signal });
          return { text };
        },
        presentCall: (args) => ({
          card: 'generic',
          title: String(args.question ?? '').slice(0, 120) || 'Read image',
          kind: 'other',
          rawInput: Array.isArray(args.images) && args.images.length > 0 ? args.images : '(most recent image)',
        }),
        presentResult: (args, result) => {
          if (result.isError) return undefined;
          return { card: 'generic', title: `Vision: ${String(args.question ?? '').slice(0, 100)}` };
        },
      }),
      ),
    );
  });

  // Tell the main model the capability exists; without this line a model whose
  // runtime silently strips images never knows it could look through the tool.
  // An empty content signature keeps §24 satisfied (a function's behaviour
  // depends only on its signature): the text varies solely with config/toolName,
  // so a signal-based memo is safe across assemblies.
  ctx.inject(['systemPrompt'], (promptCtx) =>
    promptCtx.effect(() =>
      promptCtx.systemPrompt.section({
        name: 'vision-bridge',
        order: 2300,
        text: () => (live(config.guideline, true) ? GUIDELINE.replace('{TOOL}', toolName) : ''),
      }),
    ),
  );

  ctx.logger?.info?.(
    `vision bridge ready: ${toolName} → ${live(config.provider, '?')}/${live(config.model, '?')} via ${String(live(config.subagentProvider, 'spawn'))}`,
  );
}

export default apply;
