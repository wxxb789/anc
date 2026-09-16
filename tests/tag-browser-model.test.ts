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

import { classifyTagPage, TAG_PAGE_SIZE } from '../src/lib/tag-browser-model.ts';

const TAG = { key: 'gardening', label: 'Gardening' } as const;
const NOTE = { slug: 'seedling', title: 'Seedling', language: 'en' } as const;

test('an unknown tag is its own state, not an empty result', () => {
  assert.deepEqual(classifyTagPage({ known: false }), { kind: 'unknown' });
});

test('a known tag with no members is empty, not unknown', () => {
  // Unreachable through the writer today, and still the answer the model must
  // give if a snapshot ever carried one: the tag exists and has no notes.
  assert.deepEqual(classifyTagPage({ known: true, tag: TAG, notes: [], nextCursor: null }), {
    kind: 'empty',
  });
});

test('a known tag with rows keeps its continuation, and exhaustion is a null cursor', () => {
  assert.deepEqual(classifyTagPage({ known: true, tag: TAG, notes: [NOTE], nextCursor: 'seedling' }), {
    kind: 'page',
    notes: [NOTE],
    nextCursor: 'seedling',
  });
  // The same shape with a null cursor is an exhausted page, which the browser
  // presents as "no more results" — never as the unknown sentence.
  assert.deepEqual(classifyTagPage({ known: true, tag: TAG, notes: [NOTE], nextCursor: null }), {
    kind: 'page',
    notes: [NOTE],
    nextCursor: null,
  });
});

test('the browser page size is a reader-chosen constant', () => {
  assert.equal(TAG_PAGE_SIZE, 10);
});
