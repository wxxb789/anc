/**
 * The tag browser's pure classification, over the three reader-visible
 * outcomes the snapshot query distinguishes.
 *
 * `write-snapshot.ts` emits only tags that have a member, so a known tag with
 * an empty list cannot come out of the shipped database; the model boundary is
 * where that state is still representable, and a caller that collapsed it into
 * "unknown" would tell a reader the tag never existed. These cases pin the
 * boundary: unknown, known-but-empty, an exhausted page, and a page with a
 * continuation are four distinct answers.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { classifyTagPage, TAG_PAGE_SIZE, TAG_WINDOW_SIZE, tagWindow } from '../src/lib/tag-browser-model.ts';

const TAG = { key: 'gardening', label: 'Gardening' } as const;
const NOTE = { slug: 'seedling', title: 'Seedling', language: 'en' } as const;

test('an unknown tag is its own state, not an empty result', () => {
  assert.deepEqual(classifyTagPage({ known: false }), { kind: 'unknown' });
});

test('a known tag with no members is empty, not unknown', () => {
  // Unreachable through the writer today, and still the answer the model must
  // give if a snapshot ever carried one: the tag exists and has no notes.
  assert.deepEqual(classifyTagPage({ known: true, tag: TAG, total: 0, notes: [], nextCursor: null }), {
    kind: 'empty',
  });
});

test('a known tag with rows keeps its continuation, and exhaustion is a null cursor', () => {
  assert.deepEqual(classifyTagPage({ known: true, tag: TAG, total: 2, notes: [NOTE], nextCursor: 'seedling' }), {
    kind: 'page',
    notes: [NOTE],
    nextCursor: 'seedling',
  });
  // The same shape with a null cursor is an exhausted page, which the browser
  // presents as "no more results" — never as the unknown sentence.
  assert.deepEqual(classifyTagPage({ known: true, tag: TAG, total: 1, notes: [NOTE], nextCursor: null }), {
    kind: 'page',
    notes: [NOTE],
    nextCursor: null,
  });
});

test('the browser page size is a reader-chosen constant', () => {
  assert.equal(TAG_PAGE_SIZE, 10);
});

test('a window covers the whole collection when it is smaller than the bound', () => {
  assert.deepEqual(tagWindow(0, 0), { start: 0, end: 0 });
  assert.deepEqual(tagWindow(21, 0), { start: 0, end: 21 });
  assert.deepEqual(tagWindow(21, 100), { start: 0, end: 21 });
});

test('a window at or beyond the tail is clamped to the last full page', () => {
  assert.deepEqual(tagWindow(1_000, 1_000), { start: 1_000 - TAG_WINDOW_SIZE, end: 1_000 });
  assert.deepEqual(tagWindow(1_000, 400), { start: 400, end: 400 + TAG_WINDOW_SIZE });
  assert.deepEqual(tagWindow(1_000, -5), { start: 0, end: TAG_WINDOW_SIZE });
});
