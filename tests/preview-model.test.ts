/**
 * The preview's pure half: what a payload may become, and where the panel goes.
 *
 * The clamping arithmetic is the part of TK-07 most likely to be subtly wrong,
 * and a browser test can only prove it for the link positions a corpus happens
 * to contain — the published corpus is one note, so no note page there links to
 * another note at all. These gates drive the geometry directly, so every edge,
 * the flip, and the no-room-either-way case are reachable regardless of what the
 * artifact holds.
 *
 * Each case names the reader-visible defect it prevents rather than restating
 * the arithmetic: a test that recomputes the implementation proves only that
 * two copies agree.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  FRAGMENT_LIMIT,
  PREVIEW_GAP_PX,
  VIEWPORT_MARGIN_PX,
  placePreview,
  previewFragment,
  readPreviewIndex,
  type PreviewSize,
} from '../src/lib/preview-model.ts';

/** A phone-sized viewport at the narrowest width the design system supports. */
const NARROW: PreviewSize = { width: 320, height: 640 };
const WIDE: PreviewSize = { width: 1280, height: 800 };

/** A panel roughly the size the stylesheet gives it: 22rem wide, four lines. */
const PANEL: PreviewSize = { width: 352, height: 140 };

/** The rectangle of a link, as `getBoundingClientRect` reports it. */
function link(left: number, top: number, height = 20) {
  return { left, top, bottom: top + height };
}

// --- The four edges -----------------------------------------------------------

test('a link at the left edge does not push the panel off the left of the screen', () => {
  const { left } = placePreview(link(0, 300), PANEL, WIDE);
  assert.equal(left, VIEWPORT_MARGIN_PX);
});

test('a link at the right edge does not push the panel off the right of the screen', () => {
  // The defect this catches shipped: the old code clamped `left` against
  // `innerWidth - 360` with the panel's width hardcoded, so a narrower viewport
  // or a different panel width silently produced a negative or overhanging left.
  const { left } = placePreview(link(WIDE.width - 40, 300), PANEL, WIDE);
  assert.equal(left + PANEL.width, WIDE.width - VIEWPORT_MARGIN_PX);
});

test('a link near the bottom flips the panel above it rather than off the screen', () => {
  const anchor = link(100, WIDE.height - 60);
  const { top } = placePreview(anchor, PANEL, WIDE);
  assert.equal(top + PANEL.height, anchor.top - PREVIEW_GAP_PX);
  assert.ok(top >= VIEWPORT_MARGIN_PX, 'the flipped panel starts above the top of the viewport');
});

test('a link near the top keeps the panel below it and inside the top edge', () => {
  const { top } = placePreview(link(100, 4), PANEL, WIDE);
  assert.ok(top >= VIEWPORT_MARGIN_PX, `the panel starts at ${top}px, above the viewport margin`);
});

test('the panel sits below the link whenever there is room, and is not flipped for nothing', () => {
  const anchor = link(100, 100);
  const { top } = placePreview(anchor, PANEL, WIDE);
  assert.equal(top, anchor.bottom + PREVIEW_GAP_PX);
});

// --- Where neither side fits --------------------------------------------------

test('a link with no room either way keeps the panel on screen rather than centred on the link', () => {
  // A short viewport — a phone in landscape with the browser chrome showing —
  // where the panel is taller than the space above *or* below the link. Both
  // clamps engage, and the guarantee is only that the panel is fully visible.
  const short: PreviewSize = { width: 320, height: 200 };
  const { top } = placePreview(link(20, 90), PANEL, short);
  assert.ok(top >= VIEWPORT_MARGIN_PX, `top is ${top}px, above the viewport`);
  assert.ok(
    top + PANEL.height <= short.height - VIEWPORT_MARGIN_PX,
    `the panel ends at ${top + PANEL.height}px in a ${short.height}px viewport`,
  );
});

test('a panel taller than the viewport keeps its top-left corner visible', () => {
  // Nothing can make it fit, so one edge has to be given up. Giving up the far
  // edge is what keeps the title — where reading starts — on the screen; the
  // opposite choice would scroll the reader's own entry point out of view.
  const tall: PreviewSize = { width: 400, height: 900 };
  const { left, top } = placePreview(link(40, 300), tall, NARROW);
  assert.equal(top, VIEWPORT_MARGIN_PX);
  assert.equal(left, VIEWPORT_MARGIN_PX);
});

test('the panel never overflows a 320 px viewport for any link position on the page', () => {
  // The acceptance criterion, swept rather than sampled: every whole-pixel
  // horizontal and vertical position a link could occupy.
  //
  // The panel is deliberately *smaller* than the viewport in both axes. A panel
  // as wide as the viewport pins the horizontal clamp band to a single point, so
  // `left` comes back as the same constant for every iteration and the sweep
  // re-asserts what `clamp` guarantees by construction — it would pass with the
  // desired position replaced by any expression at all. Review caught exactly
  // that: the first version used a 304 px panel in a 320 px viewport, band
  // `[8, 8]`, and survived replacing the desired coordinate with `-99999`.
  //
  // Bounds alone are therefore not enough, so each iteration also checks the
  // *relationship* to the link: inside the free band the panel tracks the link's
  // own left edge, and vertically it sits either below or above the link rather
  // than somewhere unrelated to it.
  const narrowPanel: PreviewSize = { width: 200, height: 140 };
  for (let x = -20; x <= NARROW.width + 20; x += 1) {
    for (let y = -20; y <= NARROW.height + 20; y += 4) {
      const anchor = link(x, y);
      const { left, top } = placePreview(anchor, narrowPanel, NARROW);
      const where = `link at (${x}, ${y})`;

      assert.ok(left >= VIEWPORT_MARGIN_PX, `${where}: panel left is ${left}px`);
      assert.ok(top >= VIEWPORT_MARGIN_PX, `${where}: panel top is ${top}px`);
      assert.ok(
        left + narrowPanel.width <= NARROW.width - VIEWPORT_MARGIN_PX,
        `${where}: panel right edge is ${left + narrowPanel.width}px`,
      );
      assert.ok(
        top + narrowPanel.height <= NARROW.height - VIEWPORT_MARGIN_PX,
        `${where}: panel bottom edge is ${top + narrowPanel.height}px`,
      );

      // Aligned with the link wherever the clamps leave a choice: a panel that
      // is on screen but not near the link it describes is a different defect,
      // and one the bounds above cannot see.
      const freeLeft = x >= VIEWPORT_MARGIN_PX && x + narrowPanel.width <= NARROW.width - VIEWPORT_MARGIN_PX;
      if (freeLeft) assert.equal(left, x, `${where}: the panel is not aligned with the link`);

      const isBelow = top === anchor.bottom + PREVIEW_GAP_PX;
      const isAbove = top + narrowPanel.height === anchor.top - PREVIEW_GAP_PX;
      const isClamped = top === VIEWPORT_MARGIN_PX || top + narrowPanel.height === NARROW.height - VIEWPORT_MARGIN_PX;
      assert.ok(
        isBelow || isAbove || isClamped,
        `${where}: the panel is at ${top}px — neither below the link, above it, nor against an edge`,
      );
    }
  }
});

test('the panel flips above only when there is more room above, not merely less below', () => {
  // The second half of the flip condition, which the sweep above cannot reach
  // and which review found untested: deleting `roomAbove > roomBelow` passed
  // every other gate in this file. It matters for a link in the *middle* of a
  // short viewport, where a tall panel fits neither above nor below — flipping
  // on "does not fit below" alone sends the panel up into less room than it
  // came from, and the vertical clamp then pins it to the top edge, far from
  // the link. Measured across the viewports and panel heights this file already
  // uses: the two rules disagree at 582 anchor positions.
  const short: PreviewSize = { width: 320, height: 640 };
  const tallPanel: PreviewSize = { width: 300, height: 300 };
  const anchor = link(10, 305);

  // Room below is 640 - 8 - 333 = 299; room above is 305 - 8 - 8 = 289. The
  // panel (300) fits in neither, and below is the roomier of the two, so it
  // stays below and is clamped to the bottom edge.
  const { top } = placePreview(anchor, tallPanel, short);
  assert.equal(
    top,
    short.height - VIEWPORT_MARGIN_PX - tallPanel.height,
    'a panel with more room below it was flipped above anyway',
  );
  assert.notEqual(top, VIEWPORT_MARGIN_PX, 'the panel was flipped and then pinned to the top edge');

  // The mirror case, so the pair proves the condition rather than one side of
  // it: the same panel and the same viewport, with the link low enough that
  // above really is roomier.
  const low = link(10, 500);
  assert.equal(
    placePreview(low, tallPanel, short).top + tallPanel.height,
    low.top - PREVIEW_GAP_PX,
    'a panel with more room above it was not flipped',
  );
});

// --- Payload lookup -----------------------------------------------------------

test('a well-formed payload becomes a lookup by slug', () => {
  const index = readPreviewIndex({
    version: 1,
    entries: [
      { slug: 'first-note', title: 'First Note', excerpt: 'An excerpt.' },
      { slug: 'second-note', title: 'Second Note', excerpt: '' },
    ],
  });
  assert.deepEqual(index.get('first-note'), { title: 'First Note', excerpt: 'An excerpt.' });
  // An empty excerpt is legal in the content contract and must survive: it is
  // the one required string the schema admits empty.
  assert.deepEqual(index.get('second-note'), { title: 'Second Note', excerpt: '' });
  assert.equal(index.get('no-such-note'), undefined);
});

test('the lookup carries only the three public preview fields', () => {
  // The projection is `{slug, title, excerpt}`. If a future artifact leaked a
  // private field into the index, the panel must still be structurally incapable
  // of showing it — the reader is what bounds this, not the exporter alone.
  const index = readPreviewIndex({
    entries: [
      { slug: 'a-note', title: 'A Note', excerpt: 'Public.', source_path: 'C:/vault/private.md' },
    ],
  });
  assert.deepEqual(Object.keys(index.get('a-note')!).sort(), ['excerpt', 'title']);
});

test('a malformed payload yields an empty lookup rather than throwing', () => {
  // Every one of these is a "fail silently" case from the ticket: the reader's
  // link still works, and nothing reaches the console.
  const malformed: unknown[] = [
    undefined,
    null,
    'not json at all',
    42,
    [],
    {},
    { entries: null },
    { entries: 'nope' },
    { entries: {} },
  ];
  for (const payload of malformed) {
    assert.equal(readPreviewIndex(payload).size, 0, `${JSON.stringify(payload)} produced entries`);
  }
});

test('an entry missing or mistyping a preview field is skipped, not half-rendered', () => {
  const index = readPreviewIndex({
    entries: [
      null,
      'a string',
      { slug: 'no-title', excerpt: 'x' },
      { slug: 'no-excerpt', title: 'x' },
      { title: 'no slug', excerpt: 'x' },
      { slug: 'bad-title', title: 42, excerpt: 'x' },
      { slug: 'bad-excerpt', title: 'x', excerpt: ['x'] },
      { slug: 'good-note', title: 'Good', excerpt: 'Fine.' },
    ],
  });
  assert.deepEqual([...index.keys()], ['good-note']);
});

test('a payload key that names a prototype member cannot be looked up as an entry', () => {
  // The index is fetched, so its keys are attacker-shaped in principle. A plain
  // object would answer `index['toString']` with a function; a Map has no such
  // key, and the `undefined` below is what the caller reads as "not published".
  const index = readPreviewIndex({
    entries: [{ slug: '__proto__', title: 'x', excerpt: 'y' }],
  });
  assert.equal(index.get('constructor'), undefined);
  assert.equal(index.get('toString'), undefined);
  assert.deepEqual(index.get('__proto__'), { title: 'x', excerpt: 'y' });
});

// --- Heading targets ----------------------------------------------------------

test('a link with no fragment shows no section line', () => {
  assert.equal(previewFragment(''), undefined);
  assert.equal(previewFragment('#'), undefined);
});

test('a heading target is shown as the fragment the address bar will show', () => {
  assert.equal(previewFragment('#introduction'), '#introduction');
  // Percent-escapes are what a non-Latin heading slug arrives as.
  assert.equal(previewFragment('#%E4%B8%AD%E6%96%87'), '#中文');
});

test('a malformed escape is shown raw rather than throwing', () => {
  // `decodeURIComponent('%zz')` throws, and a hand-written href can contain it.
  assert.equal(previewFragment('#%zz'), '#%zz');
});

test('a long fragment is bounded so one heading cannot stretch the panel', () => {
  const shown = previewFragment(`#${'a'.repeat(FRAGMENT_LIMIT * 2)}`)!;
  assert.equal(shown.length, FRAGMENT_LIMIT + 2, 'the bound is the limit, plus "#" and the ellipsis');
  assert.ok(shown.endsWith('…'), 'a truncated fragment does not say it was truncated');
});
