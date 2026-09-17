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

test('every named operation has one minimal accepted shape that can carry no SQL, URL, or path', () => {
  for (const type of SNAPSHOT_OPERATIONS) {
    const message: Record<string, unknown> = { id: 1, type };
    const lookup = type === 'byTag' || type === 'globalGraph' ? 'tagKey' : 'slug';
    message[lookup] = lookup === 'tagKey' ? 'garden-notes' : 'note-a';

    assert.ok(isSnapshotMessage(message), `${type} was refused`);
    // Extra fields are ignored by the Worker; the accepted keys cannot carry
    // executable or location data.
    assert.deepEqual(
      Object.keys(message).sort(),
      ['id', lookup, 'type'].sort(),
      `${type} grew a field the Worker would have to trust`,
    );
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
    { id: 1, type: 'localGraph', slug: '' },
    { id: 1, type: 'preview', slug: '../../etc/passwd' },
    // SQL-ish or non-canonical text is refused by the lookup grammar rather
    // than by a denylist, so no interpolation is possible by construction.
    { id: 1, type: 'preview', slug: "note-a' OR 1=1 --" },
    { id: 1, type: 'preview', slug: 'Note-A' },
    { id: 1, type: 'preview', slug: 'a'.repeat(129) },
    { id: 1, type: 'byTag' },
    { id: 1, type: 'byTag', tagKey: 'a/b' },
    { id: 1, type: 'byTag', tagKey: 'tag\u0000name' },
    { id: 1, type: 'byTag', tagKey: 'a'.repeat(129) },
    { id: 1, type: 'byTag', tagKey: 'garden-notes', cursor: 'not a slug' },
    { id: 1, type: 'byTag', tagKey: 'garden-notes', pageSize: '10' },
    { id: 1, type: 'backlinks', slug: 'note-a', cursor: 'not a slug' },
    { id: 1, type: 'backlinks', slug: 'note-a', cursor: 'a'.repeat(129) },
    { id: 1, type: 'backlinks', slug: 'note-a', pageSize: '10' },
    { id: 1, type: 'globalGraph', tagKey: '' },
    { id: 1, type: 'globalGraph', tagKey: 'a/b' },
  ];
  for (const value of rejected) assert.equal(isSnapshotMessage(value), false, `accepted ${JSON.stringify(value)}`);
});

test('page size is clamped to the accepted range for every paginated operation', () => {
  const request = (type: 'backlinks' | 'byTag', pageSize?: number) =>
    type === 'byTag'
      ? { id: 1, type, tagKey: 'garden-notes', ...(pageSize === undefined ? {} : { pageSize }) }
      : { id: 1, type, slug: 'a', ...(pageSize === undefined ? {} : { pageSize }) };

  for (const type of ['backlinks', 'byTag'] as const) {
    assert.equal(requestPageSize(request(type)), DEFAULT_PAGE_SIZE);
    assert.equal(requestPageSize(request(type, 10)), 10);
    assert.equal(requestPageSize(request(type, 10_000)), MAX_PAGE_SIZE);
    assert.equal(requestPageSize(request(type, 0)), DEFAULT_PAGE_SIZE);
  }
});

test('a reply is narrowed to the result type the caller asked for', () => {
  const reply: SnapshotReply = {
    id: 1,
    ok: true,
    result: { type: 'preview', preview: { slug: 'a', title: 'A', excerpt: '', language: 'en', aliases: [] } },
    // The success branch carries the Worker's own measured operation span
    // beside the result; narrowing must not depend on it.
    operationMs: 0.5,
  };
  assert.ok(isResultOf(reply, 'preview'));
  assert.equal(isResultOf(reply, 'backlinks'), false);
  assert.equal(isResultOf({ id: 1, ok: false, code: 'timeout' }, 'preview'), false);
});
