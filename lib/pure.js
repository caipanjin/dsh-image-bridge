/**
 * Pure helpers for the vision-bridge plugin.
 *
 * This module has NO external dependencies (only the JavaScript standard
 * library), so it can be imported and unit-tested with bare Node even though
 * the main entry (`lib/index.js`) relies on `@deepseek-ai/*` peer packages that
 * only resolve inside the Harness runtime.
 *
 * @module dsh-image-bridge/pure
 */

/** File extension → media type, for attachments created from local paths. */
export const IMAGE_EXTENSIONS = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
]);

/**
 * Resolve a config value that may be a volatile reference (an object with a
 * `get()` method) or a plain value, falling back when the resolved value is
 * undefined, null, or the empty string.
 * @param {unknown} value
 * @param {unknown} fallback
 */
export function live(value, fallback) {
  const resolved =
    value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
  return resolved === undefined || resolved === null || resolved === '' ? fallback : resolved;
}

/** Guess a media type from a file name; the attachment store verifies the real bytes. */
export function sniffMediaType(fileName) {
  const extension = /\.([A-Za-z0-9]+)$/u.exec(fileName ?? '')?.[1]?.toLowerCase();
  return IMAGE_EXTENSIONS.get(extension) ?? 'image/png';
}

/** Whether a string looks like a filesystem path rather than an attachment id. */
export function looksLikePath(value) {
  return /^(?:~|\/|\.{1,2}[\\/]|[A-Za-z]:[\\/])/u.test(value) || value.includes('/') || value.includes('\\');
}

/** Image blocks carried by one message-like `{ content }` value, in order. */
export function imagesOf(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.filter((block) => block !== null && typeof block === 'object' && block.type === 'image');
}

/**
 * Image blocks produced by one session event, newest sources first. A user may
 * send an image directly (`user/message`), and a tool — `read_image`, a
 * screenshot tool — may return one as its result (`tool/result.message`), which
 * is how most images reach the conversation in practice.
 */
export function imagesOfEvent(event) {
  if (event?.type === 'user/message') return imagesOf(event.data);
  if (event?.type === 'tool/result') return imagesOf(event.data?.message ?? event.data);
  return [];
}

/**
 * The image most recently seen in the caller's conversation when the model omits
 * `images`: whatever it (or a tool) most recently put in front of the model.
 * @param session - the calling Agent's session.
 * @returns the newest image block, or `{ offloaded: true }` when the only recent
 *   image was dropped by context compaction, or undefined when there never was one.
 */
export function recentImage(session) {
  try {
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
    let sawOffload = false;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      // An `image/offload` record means compaction stripped images from earlier
      // turns; a live image block after it would have been returned above.
      if (event?.type === 'image/offload' && Array.isArray(event.data?.targets) && event.data.targets.length > 0) {
        sawOffload = true;
      }
      const images = imagesOfEvent(event);
      if (images.length > 0) return images[images.length - 1];
    }
    if (sawOffload) return { offloaded: true };
  } catch {
    // A session that cannot be read simply has no recent image.
  }
  return undefined;
}

/** Join the child's final assistant text blocks. */
export function outputText(output) {
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
export function buildPrompt(images, instruction, question) {
  const labeled =
    images.length <= 1
      ? images
      : images.flatMap((image, index) => [
          { type: 'text', text: `Image ${index + 1}:` },
          image,
        ]);
  return [...labeled, { type: 'text', text: `${instruction}\n\nTask from the main agent: ${question}` }];
}
