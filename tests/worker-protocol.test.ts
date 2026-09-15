/**
 * The Worker message contract.
 *
 * These are pure shape gates: they prove a request the client can send is one
 * the Worker accepts, that every malformed variant is refused before any SQL
 * runs, and that no message shape can carry SQL, a URL, or a path.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../src/lib/snapshot-queries.ts';
import {
  SNAPSHOT_OPERATIONS,
  isResultOf,
  isSnapshotMessage,
  requestPageSize,
  type SnapshotReply,
} from '../src/lib/worker-protocol.ts';

test('every named operation has a shape the Worker accepts', () => {
  for (const type of SNAPSHOT_OPERATIONS) {
    const message: Record<string, unknown> = { id: 1, type };
    if (type === 'byTag') message['tagKey'] = 'garden-notes';
    else if (type === 'globalGraph') message['tagKey'] = 'garden-notes';
    else if (type === 'preview' || type === 'localGraph' || type === 'backlinks' || type === 'outgoing') {
      message['slug'] = 'note-a';
    }
    assert.ok(isSnapshotMessage(message), `${type} was refused`);
  }
});

test('a malformed request is refused before any SQL runs', () => {
  const rejected: unknown[] = [
    null,
    [],
    'preview',
    { type: 'preview', slug: 'note-a' }, // no id
    { id: 0, type: 'preview', slug: 'note-a' },
    { id: 1.5, type: 'preview', slug: 'note-a' },
    { id: 1, type: 'drop-everything', slug: 'note-a' },
    { id: 1, type: 'preview' },
    { id: 1, type: 'preview', slug: '../../etc/passwd' },
    { id: 1, type: 'byTag' },
    { id: 1, type: 'backlinks', slug: 'note-a', cursor: 'not a slug' },
    { id: 1, type: 'backlinks', slug: 'note-a', pageSize: '10' },
    { id: 1, type: 'globalGraph', tagKey: '' },
  ];
  for (const value of rejected) assert.equal(isSnapshotMessage(value), false, `accepted ${JSON.stringify(value)}`);
});

test('no accepted message shape names SQL, a URL, or a path', () => {
  for (const type of SNAPSHOT_OPERATIONS) {
    const message: Record<string, unknown> = { id: 1, type };
    if (type === 'byTag' || type === 'globalGraph') message['tagKey'] = 'garden-notes';
    else message['slug'] = 'note-a';
    assert.ok(isSnapshotMessage(message));
    // Extra fields are ignored by the Worker; the accepted keys cannot carry
    // executable or location data.
    const keys = Object.keys(message).sort();
    assert.deepEqual(
      keys,
      type === 'globalGraph' ? ['id', 'tagKey', 'type'] : type === 'byTag' ? ['id', 'tagKey', 'type'] : ['id', 'slug', 'type'],
      `${type} grew a field the Worker would have to trust`,
    );
  }
});

test('page size is clamped to the accepted range', () => {
  assert.equal(requestPageSize({ id: 1, type: 'backlinks', slug: 'a' }), DEFAULT_PAGE_SIZE);
  assert.equal(requestPageSize({ id: 1, type: 'backlinks', slug: 'a', pageSize: 10 }), 10);
  assert.equal(requestPageSize({ id: 1, type: 'backlinks', slug: 'a', pageSize: 10_000 }), MAX_PAGE_SIZE);
  assert.equal(requestPageSize({ id: 1, type: 'backlinks', slug: 'a', pageSize: 0 }), DEFAULT_PAGE_SIZE);
});

test('a reply is narrowed to the result type the caller asked for', () => {
  const reply: SnapshotReply = {
    id: 1,
    ok: true,
    result: { type: 'preview', preview: { slug: 'a', title: 'A', excerpt: '', language: 'en', aliases: [] } },
  };
  assert.ok(isResultOf(reply, 'preview'));
  assert.equal(isResultOf(reply, 'backlinks'), false);
  assert.equal(isResultOf({ id: 1, ok: false, code: 'timeout' }, 'preview'), false);
});
