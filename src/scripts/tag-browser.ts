/**
 * Reader-facing tag browsing over the shared lazy snapshot runtime.
 *
 * `byTag` is a named operation with cursor pagination; this is its reader-facing
 * consumer. It is mounted on `/tags/` (a tag chooser) and `/tags/<tag>/` (one
 * fixed tag), and every chrome string arrives as a `data-` attribute the build
 * wrote, so no locale table ships to the browser and no tag is normalized here —
 * the key is sent exactly as the static route spells it.
 *
 * The static `NoteList`/`FacetIndex` above it remains the complete no-JS route;
 * this region is hidden until the script runs and unhides the static list on any
 * failure.
 */

import { noteRoute } from '../lib/route-path.ts';
import { classifyTagPage, TAG_PAGE_SIZE, type TagBrowseState } from '../lib/tag-browser-model.ts';
import { requestByTag } from './snapshot-client.ts';

export {};

/** Dataset keys, matching `datasetAttribute('tagBrowse…')` in the Astro markup. */
const STATUS = {
  loading: 'tagBrowseLoading',
  empty: 'tagBrowseEmpty',
  exhausted: 'tagBrowseExhausted',
  unknown: 'tagBrowseUnknown',
  failed: 'tagBrowseFailed',
} as const;

const root = document.querySelector<HTMLElement>('#tag-browser');
if (root) install(root);

function install(root: HTMLElement): void {
  const mode = root.dataset['mode'] === 'switch' ? 'switch' : 'fixed';
  const pageSize = Number(root.dataset['pageSize']) || TAG_PAGE_SIZE;
  const staticList = document.querySelector<HTMLElement>('#tag-static-list');
  const chooser = root.querySelector<HTMLSelectElement>('#tag-browser-select');
  const start = root.querySelector<HTMLButtonElement>('#tag-browse-start');
  const more = root.querySelector<HTMLButtonElement>('#tag-browse-more');
  const results = root.querySelector<HTMLOListElement>('#tag-browser-results')!;
  const status = root.querySelector<HTMLElement>('#tag-browser-status')!;
  const current = root.querySelector<HTMLElement>('#tag-browser-current')!;

  const string = (key: (typeof STATUS)[keyof typeof STATUS]): string => root.dataset[key] ?? '';

  let generation = 0;
  let tagKey = mode === 'fixed' ? (root.dataset['tagKey'] ?? '') : '';
  let cursor: string | null = null;

  root.hidden = false;

  const reset = (): void => {
    results.replaceChildren();
    if (more !== null) more.hidden = true;
    current.hidden = true;
    status.textContent = '';
  };

  const pageLanguage = (): string => (document.documentElement.lang || 'en').toLowerCase();

  async function load(after: string | null, forGeneration: number): Promise<void> {
    if (tagKey === '') {
      reset();
      return;
    }
    status.textContent = string(STATUS.loading);
    let page;
    try {
      page = (await requestByTag(tagKey, after, pageSize)).page;
    } catch {
      if (forGeneration !== generation) return;
      // The static list is never removed before page 1 renders, so a failure
      // leaves the complete no-JS list on screen.
      if (staticList !== null) staticList.hidden = false;
      status.textContent = string(STATUS.failed);
      return;
    }
    if (forGeneration !== generation) return; // a stale tag's reply cannot replace this one

    const state: TagBrowseState = classifyTagPage(page);
    if (state.kind === 'unknown') {
      if (more !== null) more.hidden = true;
      status.textContent = string(STATUS.unknown);
      return;
    }
    if (state.kind === 'empty') {
      if (more !== null) more.hidden = true;
      status.textContent = string(STATUS.empty);
      return;
    }

    const language = pageLanguage();
    for (const note of state.notes) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = noteRoute(note.slug);
      link.textContent = note.title;
      if (note.language.toLowerCase() !== language) link.lang = note.language;
      item.append(link);
      results.append(item);
    }
    if (page.known) {
      current.textContent = page.tag.label;
      current.hidden = false;
    }
    cursor = state.nextCursor;
    if (cursor === null) {
      if (more !== null) more.hidden = true;
      status.textContent = string(STATUS.exhausted);
    } else {
      if (more !== null) more.hidden = false;
      status.textContent = '';
    }
  }

  /** Explicit intent: choosing a tag or pressing Start. */
  function select(nextKey: string): void {
    const forGeneration = ++generation; // invalidates any in-flight reply
    tagKey = nextKey;
    cursor = null;
    reset();
    if (staticList !== null) staticList.hidden = true; // only after a selection is made
    void load(null, forGeneration);
  }

  start?.addEventListener('click', () => select(mode === 'fixed' ? (root.dataset['tagKey'] ?? '') : ''));
  chooser?.addEventListener('change', () => select(chooser.value));
  more?.addEventListener('click', () => {
    const forGeneration = generation;
    void load(cursor, forGeneration);
  });
}
