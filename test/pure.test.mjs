/**
 * Unit tests for the vision-bridge pure helpers.
 *
 * Run with `npm test` (which runs `node --test`). These helpers live in
 * `lib/pure.js`, which has no external imports, so they run under bare Node
 * without the Harness runtime or any `@deepseek-ai/*` packages.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildPrompt,
  imagesOf,
  imagesOfEvent,
  live,
  looksLikePath,
  outputText,
  recentImage,
  sniffMediaType,
} from '../lib/pure.js';

test('live: returns plain values, resolving volatile getters and falling back on empty', () => {
  assert.equal(live('x', 'fb'), 'x');
  assert.equal(live(undefined, 'fb'), 'fb');
  assert.equal(live(null, 'fb'), 'fb');
  assert.equal(live('', 'fb'), 'fb');
  assert.equal(live({ get: () => 'volatile' }, 'fb'), 'volatile');
  assert.equal(live({ get: () => '' }, 'fb'), 'fb');
  assert.equal(live(0, 'fb'), 0);
  assert.equal(live(false, 'fb'), false);
});

test('sniffMediaType: maps known extensions, defaults to image/png', () => {
  assert.equal(sniffMediaType('a.png'), 'image/png');
  assert.equal(sniffMediaType('a.PNG'), 'image/png');
  assert.equal(sniffMediaType('dir/b.jpg'), 'image/jpeg');
  assert.equal(sniffMediaType('c.jpeg'), 'image/jpeg');
  assert.equal(sniffMediaType('d.webp'), 'image/webp');
  assert.equal(sniffMediaType('e.gif'), 'image/gif');
  assert.equal(sniffMediaType('noext'), 'image/png');
  assert.equal(sniffMediaType(undefined), 'image/png');
  assert.equal(sniffMediaType('weird.tiff'), 'image/png');
});

test('looksLikePath: paths yes, attachment ids no', () => {
  for (const value of ['/abs/x.png', '~/x.png', './x.png', '../x.png', 'C:\\x.png', 'a/b.png', 'a\\b.png']) {
    assert.equal(looksLikePath(value), true, value);
  }
  for (const value of ['att_0123456789abcdef', 'abc123', 'plain']) {
    assert.equal(looksLikePath(value), false, value);
  }
});

test('imagesOf: filters image blocks from a message content array', () => {
  const message = {
    content: [
      { type: 'text', text: 'hi' },
      { type: 'image', attachment: { attachmentId: 'a' } },
      null,
      { type: 'image', attachment: { attachmentId: 'b' } },
    ],
  };
  const images = imagesOf(message);
  assert.equal(images.length, 2);
  assert.equal(images[0].attachment.attachmentId, 'a');
  assert.equal(images[1].attachment.attachmentId, 'b');
  assert.deepEqual(imagesOf(undefined), []);
  assert.deepEqual(imagesOf({}), []);
});

test('imagesOfEvent: reads user/message and tool/result; ignores others', () => {
  assert.deepEqual(imagesOfEvent({ type: 'user/message', data: { content: [{ type: 'image', attachment: {} }] } }).length, 1);
  assert.deepEqual(
    imagesOfEvent({ type: 'tool/result', data: { message: { content: [{ type: 'image', attachment: {} }] } } }).length,
    1,
  );
  assert.deepEqual(imagesOfEvent({ type: 'tool/result', data: { content: [{ type: 'image', attachment: {} }] } }).length, 1);
  assert.deepEqual(imagesOfEvent({ type: 'assistant/message', data: {} }), []);
  assert.deepEqual(imagesOfEvent(undefined), []);
});

test('recentImage: newest image wins; undefined when none; offloaded marker honored', () => {
  const imgA = { type: 'image', attachment: { attachmentId: 'a' } };
  const imgB = { type: 'image', attachment: { attachmentId: 'b' } };
  const session = {
    snapshotEvents: () => [
      { type: 'user/message', data: { content: [imgA] } },
      { type: 'tool/result', data: { message: { content: [imgB] } } },
    ],
  };
  assert.equal(recentImage(session).attachment.attachmentId, 'b');

  assert.equal(recentImage({ snapshotEvents: () => [] }), undefined);
  assert.equal(recentImage(undefined), undefined);
  assert.equal(recentImage({}), undefined);

  // No live image, but a compaction offload event was recorded → offloaded marker.
  const offloadedSession = {
    snapshotEvents: () => [{ type: 'user/message', data: { content: [{ type: 'text', text: 'image omitted' }] } },
      { type: 'image/offload', data: { targets: [{ seq: 1, imageIndexes: [0] }] } }],
  };
  assert.deepEqual(recentImage(offloadedSession), { offloaded: true });

  // A live image newer than the offload event still wins.
  const mixed = {
    snapshotEvents: () => [
      { type: 'image/offload', data: { targets: [{ seq: 1, imageIndexes: [0] }] } },
      { type: 'user/message', data: { content: [imgA] } },
    ],
  };
  assert.equal(recentImage(mixed).attachment.attachmentId, 'a');

  // A session whose snapshotEvents throws is treated as having no image.
  assert.equal(recentImage({ snapshotEvents: () => { throw new Error('boom'); } }), undefined);
});

test('outputText: joins text blocks, trims, ignores non-text', () => {
  assert.equal(
    outputText([
      { type: 'text', text: 'Hello' },
      { type: 'image', attachment: {} },
      { type: 'text', text: 'World' },
    ]),
    'Hello\nWorld',
  );
  assert.equal(outputText([{ type: 'image', attachment: {} }]), '');
  assert.equal(outputText(undefined), '');
  assert.equal(outputText('notarray'), '');
});

test('buildPrompt: single image unlabeled; multiple labeled; question always last', () => {
  const one = buildPrompt([{ type: 'image', attachment: { attachmentId: 'a' } }], 'INST', 'Q?');
  assert.equal(one.length, 2);
  assert.deepEqual(one[0], { type: 'image', attachment: { attachmentId: 'a' } });
  assert.equal(one[1].type, 'text');
  assert.ok(one[1].text.includes('INST'));
  assert.ok(one[1].text.includes('Q?'));

  const two = buildPrompt(
    [
      { type: 'image', attachment: { attachmentId: 'a' } },
      { type: 'image', attachment: { attachmentId: 'b' } },
    ],
    'INST',
    'Q?',
  );
  // label, image, label, image, question
  assert.equal(two.length, 5);
  assert.deepEqual(two[0], { type: 'text', text: 'Image 1:' });
  assert.deepEqual(two[1], { type: 'image', attachment: { attachmentId: 'a' } });
  assert.deepEqual(two[2], { type: 'text', text: 'Image 2:' });
  assert.deepEqual(two[3], { type: 'image', attachment: { attachmentId: 'b' } });
  assert.ok(two[4].text.includes('Q?'));

  // Zero images → just the question block.
  const none = buildPrompt([], 'INST', 'Q?');
  assert.equal(none.length, 1);
  assert.equal(none[0].type, 'text');
});
