/**
 * Interactive graph exploration in a real browser.
 *
 * Goal 0005's browser evidence: a 65-note corpus with a hub past the local
 * bound, a reciprocal pair, a three-cycle with a neighbour-to-neighbour edge,
 * identically titled degree-1 notes, a zh-CN note, an isolated tag member, and
 * enough degree-0 notes that the global bound truncates. The corpus and every
 * expected set live in `tests/fixtures/graph-runtime-corpus.ts`, hand-computed
 * there so this file is an oracle and not a restatement of the selection code.
 *
 * Tests that share a page state share a test: the two long tests below drive
 * one `/notes/hub/` session and one `/graph/` session through every state that
 * does not route-abort or terminate the Worker. The failure, termination, and
 * stale-reply gates stay isolated, because each one deliberately breaks the
 * runtime the others depend on.
 *
 * The build and server come from `tests/support/browser-site.ts`, which applies
 * the shipped CSP to every response. A skipped run is not evidence, so this
 * file fails when Chromium is absent rather than skipping.
 */

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import type { Browser, Page } from 'playwright';
import { translate } from '../src/lib/translations.ts';
import type { LoadPhases } from '../src/lib/worker-protocol.ts';
import {
  CORPUS_SIZE,
  CORPUS_SLUGS,
  GARDEN_DRAWN,
  GARDEN_EDGE_COUNT,
  GLOBAL_DRAWN,
  GLOBAL_OMITTED,
  HUB_LOCAL_DRAWN,
  HUB_LOCAL_EDGES,
  HUB_NEIGHBOURS,
  HUB_REPLY_CENTERS,
  HUB_STATIC,
  HUB_TABLE,
  PEER01_DRAWN,
  PEER01_FIGURE_LANGS,
  PEER01_LOCAL_EDGES,
  PEER01_TABLE_LANGS,
  RECENTER_SEQUENCE,
  TEAM_DRAWN,
  TEAM_EDGE_COUNT,
  ZH_NOTE_DRAWN,
  ZH_NOTE_FIGURE_LANGS,
  ZH_NOTE_TABLE_LANGS,
  ZH_NOTE_TITLE,
  graphCorpus,
  peerTitle,
  type AnchorLanguage,
} from './fixtures/graph-runtime-corpus.ts';

import {
  buildAndServe,
  collectPageErrors,
  countWorkerTerminations,
  removeWorkspace,
  sqliteAssetRequests,
  tabTo,
  workerTerminations,
  WORKER_CHUNK_PATTERN,
  type RunningSite,
} from './support/browser-site.ts';

let site: RunningSite;
let browser: Browser;

async function drawnSlugs(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<Element>('.graph-nodes a.graph-node')].map((anchor) =>
      anchor.getAttribute('href')!.replace(/^\/notes\/|\/$/g, ''),
    ),
  );
}

/**
 * Split the SQLite runtime's requests into one count per class.
 *
 * The Worker chunk is a class of its own because "one Worker" is a lifecycle
 * claim; a DB or WASM count alone cannot tell a reused Worker from a replaced
 * one whose downloads came from cache. The Emscripten glue (`/wasm/sqlite-wasm.js`)
 * is separated from the `.wasm` binary because both live under `/wasm/` and one
 * `sqliteAssetRequests` count would conflate a module entry with the bytes the
 * worker instantiates.
 */
function assetCounts(urls: readonly string[]): { db: number; wasm: number; glue: number; worker: number } {
  return {
    db: urls.filter((url) => url.includes('/data/site.')).length,
    wasm: urls.filter((url) => url.endsWith('.wasm')).length,
    glue: urls.filter((url) => url.includes('/wasm/') && url.endsWith('.js')).length,
    worker: urls.filter((url) => WORKER_CHUNK_PATTERN.test(url)).length,
  };
}

/** Fill a client template's `{name}` placeholders, as `graph-client.ts` does. */
function filled(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));
}

/**
 * One Worker reply, narrowed to what the graph gates read.
 *
 * `result.graph` is the published selection shape (`NoteSummary` rows), which
 * is what lets a test prove a redraw came from a *new* reply and name the
 * center that reply carried.
 */
interface GraphReply {
  id: number;
  ok: boolean;
  code?: string;
  /** The Worker's own operation span on a successful reply. */
  operationMs?: number;
  /** Measurement-only inner-SQL sum, present only on a measured reply. */
  sqlMs?: number;
  /** Measurement-only startup decomposition, present only on a measured reply. */
  phases?: LoadPhases;
  result?: {
    type: string;
    graph?: {
      center?: { slug: string };
      nodes?: { slug: string }[];
    } | null;
  };
}

/**
 * Record every reply the page's shared Worker sends, and count constructions.
 *
 * Wrapping `window.Worker` (as `tests/preview-limits.test.ts` does) rather than
 * `Worker.prototype.addEventListener` catches a reply the client would have
 * discarded: the gate needs to see the late response exist *and* not land.
 * Construction is counted here because a terminated Worker's replacement is
 * exactly what `snapshot-client.ts` owns, and `workerTerminations` alone cannot
 * see the other half.
 */
async function recordWorkerActivity(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as unknown as {
      __graphReplies: unknown[];
      __graphWorkerCreations: number;
    };
    state.__graphReplies = [];
    state.__graphWorkerCreations = 0;
    const Original = window.Worker;
    const Counting = function (this: unknown, scriptURL: string | URL, options?: WorkerOptions): Worker {
      state.__graphWorkerCreations += 1;
      const worker = new Original(scriptURL, options);
      worker.addEventListener('message', (event: MessageEvent) => state.__graphReplies.push(event.data));
      return worker;
    };
    // Point the alias at the real prototype chain. Tests patch
    // `Worker.prototype.postMessage` after activation, and without this the
    // global `Worker` would be the wrapper with a fresh prototype that real
    // instances never consult, so the patch would silently do nothing.
    (Counting as unknown as { prototype: object }).prototype = Original.prototype;
    window.Worker = Counting as unknown as typeof Worker;
  });
}

async function graphReplies(page: Page): Promise<GraphReply[]> {
  return page.evaluate(() => (window as unknown as { __graphReplies: unknown[] }).__graphReplies) as Promise<
    GraphReply[]
  >;
}

async function workerCreations(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __graphWorkerCreations: number }).__graphWorkerCreations);
}

/** Wait until a page's live status sentence is exactly `expected`. */
async function waitForStatus(page: Page, expected: string, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    (text: string) => document.querySelector('[data-graph-status]')?.textContent === text,
    expected,
    { timeout },
  );
}

/** Wait until the first drawn node is `slug`; a redraw replaces the group. */
async function waitForCenter(page: Page, slug: string, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    (center: string) =>
      document.querySelector('.graph-nodes a.graph-node')?.getAttribute('href') === `/notes/${center}/`,
    slug,
    { timeout },
  );
}

/**
 * One merged edge line, resolved to its endpoints by proximity.
 *
 * A line's `x1`/`y1` sit on the source node's own radius, not at its centre
 * (the layout trims the line clear of the marker), so the endpoint is matched
 * to the nearest drawn circle. The ring spacing is far larger than the trim, so
 * the nearest centre is the line's own endpoint.
 */
interface ParsedEdge {
  from: string;
  to: string;
  mutual: boolean;
  incoming: boolean;
  markerStart: boolean;
  markerEnd: boolean;
}

async function parsedEdges(page: Page): Promise<ParsedEdge[]> {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll<Element>('.graph-nodes a.graph-node')].map((anchor) => {
      const circle = anchor.querySelector<Element>('circle.graph-dot')!;
      return {
        slug: anchor.getAttribute('href')!.replace(/^\/notes\/|\/$/g, ''),
        x: Number(circle.getAttribute('cx')),
        y: Number(circle.getAttribute('cy')),
      };
    });
    const nearest = (x: number, y: number): string => {
      let best = nodes[0]!;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const node of nodes) {
        const distance = (node.x - x) ** 2 + (node.y - y) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = node;
        }
      }
      return best.slug;
    };
    return [...document.querySelectorAll<SVGLineElement>('.graph-edges line')].map((line) => {
      const classes = (line.getAttribute('class') ?? '').split(/\s+/);
      return {
        from: nearest(Number(line.getAttribute('x1')), Number(line.getAttribute('y1'))),
        to: nearest(Number(line.getAttribute('x2')), Number(line.getAttribute('y2'))),
        mutual: classes.includes('graph-edge-mutual'),
        incoming: classes.includes('graph-edge-incoming'),
        markerStart: line.getAttribute('marker-start') !== null,
        markerEnd: line.getAttribute('marker-end') !== null,
      };
    });
  });
}

/** Every note anchor the scope contains, as slug plus `lang` (null when absent). */
async function anchorLanguages(page: Page, scope: string): Promise<AnchorLanguage[]> {
  return page.evaluate((selector: string) =>
    [...document.querySelectorAll<Element>(`${selector} a[href^="/notes/"]`)].map((anchor) => ({
      slug: anchor.getAttribute('href')!.replace(/^\/notes\/|\/$/g, ''),
      lang: anchor.getAttribute('lang'),
    })), scope);
}

/** One live table row: its note link, its three cells, and its joined anchors. */
interface LiveTableRow {
  note: string | null;
  relation: string;
  degree: string;
  joined: string[];
}

/**
 * The live table's rows as the client built them, cell by cell.
 *
 * The expected cell *values* are hand-written oracles beside this file; this
 * reads only what the client actually wrote, so a gate can compare rather than
 * restate. The four columns are the row head link, the relationship word, the
 * drawn degree, and the joined list as hrefs.
 */
async function liveTableRows(page: Page): Promise<LiveTableRow[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLTableRowElement>('[data-graph-region] .graph-table tbody tr')].map((row) => {
      const cells = [...row.querySelectorAll<HTMLTableCellElement>('td')];
      return {
        note: row.querySelector('th a')?.getAttribute('href') ?? null,
        relation: cells[0]?.textContent ?? '',
        degree: cells[1]?.textContent ?? '',
        joined: [...(cells[2]?.querySelectorAll('a') ?? [])].map((anchor) => anchor.getAttribute('href')!),
      };
    }),
  );
}

interface FigureFrame {
  viewBox: string;
  minX: number;
  minY: number;
  boxWidth: number;
  boxHeight: number;
  widthAttribute: number;
  heightAttribute: number;
  label: string;
  circles: { cx: number; cy: number }[];
}

/** The SVG's own frame and name, as a redraw leaves them. */
async function figureFrame(page: Page): Promise<FigureFrame> {
  return page.locator('svg.graph-svg').evaluate((svg: SVGSVGElement) => {
    const viewBox = svg.getAttribute('viewBox') ?? '';
    const [minX, minY, boxWidth, boxHeight] = viewBox.split(' ').map(Number);
    return {
      viewBox,
      minX: minX!,
      minY: minY!,
      boxWidth: boxWidth!,
      boxHeight: boxHeight!,
      widthAttribute: Number(svg.getAttribute('width')),
      heightAttribute: Number(svg.getAttribute('height')),
      label: svg.getAttribute('aria-label') ?? '',
      circles: [...svg.querySelectorAll('circle.graph-dot')].map((circle) => ({
        cx: Number(circle.getAttribute('cx')),
        cy: Number(circle.getAttribute('cy')),
      })),
    };
  });
}

/**
 * The frame is the one the drawn circles were laid out in.
 *
 * A redraw that replaced the groups but left the static `viewBox`/`width` would
 * draw the new selection inside the old box, so the two halves have to agree:
 * the attributes have to move with the layout, and every circle has to sit
 * inside the frame they state.
 */
function assertFrameCovers(frame: FigureFrame): void {
  assert.ok(frame.boxWidth > 0 && frame.boxHeight > 0, `the redrawn frame is empty: ${frame.viewBox}`);
  assert.equal(frame.widthAttribute, frame.boxWidth, 'the width attribute is not the redrawn frame');
  assert.equal(frame.heightAttribute, frame.boxHeight, 'the height attribute is not the redrawn frame');
  for (const { cx, cy } of frame.circles) {
    assert.ok(
      cx >= frame.minX && cx <= frame.minX + frame.boxWidth && cy >= frame.minY && cy <= frame.minY + frame.boxHeight,
      `a drawn node at (${cx}, ${cy}) is outside the frame ${frame.viewBox}`,
    );
  }
}

beforeAll(async () => {
  const corpus = graphCorpus();
  assert.equal(Object.keys(corpus).length, CORPUS_SIZE, 'the corpus is not the 65 notes the oracles assume');
  const buildStarted = Date.now();
  site = await buildAndServe(corpus);
  console.log(`[graph-runtime] built ${CORPUS_SIZE} notes in ${Date.now() - buildStarted} ms`);
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  if (site !== undefined) removeWorkspace(site.workspace);
});

// --- Local meaning, reader interaction, honest display, and sharing ---------------

test('hub: static 12 of 17, exact live edges, keyboard open/reset/re-centre, and one shared Worker with previews', async () => {
  const page = await browser.newPage();
  await countWorkerTerminations(page);
  await recordWorkerActivity(page);
  const requests = sqliteAssetRequests(page);
  const errors = collectPageErrors(page);
  await page.addInitScript(() => {
    (window as unknown as { __quietRenderEvents: unknown[] }).__quietRenderEvents = [];
    document.addEventListener('graph-render', (event) => {
      (window as unknown as { __quietRenderEvents: unknown[] }).__quietRenderEvents.push(
        (event as CustomEvent<{ scope: string; ms: number }>).detail,
      );
    });
  });
  await page.goto(`${site.origin}/notes/hub/`, { waitUntil: 'load' });
  await page.waitForTimeout(300);

  const region = page.locator('[data-graph-region="note-graph"]');

  // --- The static baseline a reader gets before any intent --------------------
  assert.deepEqual(requests, [], 'ordinary reading requested SQLite assets');
  assert.equal(
    await region.locator('.graph-nodes a.graph-node').count(),
    HUB_STATIC.figureNodes,
    'the static figure is not 13 nodes',
  );
  assert.equal(
    await region.locator('.graph-table tbody tr').count(),
    HUB_STATIC.tableRows,
    'the static table is not 13 rows',
  );
  assert.equal(
    await region.locator('[data-graph-figure-label]').isVisible(),
    true,
    'the static figure label is not shown before any intent',
  );

  const bound = ((await region.locator('.graph-bound span').textContent()) ?? '').trim();
  assert.equal(
    bound,
    translate('en').graphBoundedLocal(HUB_STATIC.shown, HUB_STATIC.total),
    'the bound sentence is not the drawn/total pair',
  );
  // The template equality above cannot see `{shown}` and `{total}` swapped, so
  // the two numbers are also checked directly, as words on the built page.
  assert.match(bound, /\b12 of 17\b/, `the bound sentence does not state 12 of 17: ${bound}`);

  // The outgoing list is the complete authored edge set: the five neighbours the
  // local bound dropped are named there even though the figure omits them.
  const outgoing = await page
    .locator('aside[aria-labelledby="outgoing-title"] .relations-list a')
    .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href')));
  assert.equal(outgoing.length, HUB_STATIC.outgoingLinks, `the outgoing list is not complete: ${outgoing.length}`);
  assert.deepEqual(
    [...outgoing].sort(),
    HUB_NEIGHBOURS.map((slug) => `/notes/${slug}/`).sort(),
  );
  for (const omitted of HUB_NEIGHBOURS.slice(12)) {
    assert.ok(outgoing.includes(`/notes/${omitted}/`), `the outgoing list omits ${omitted}`);
  }

  const staticFrame = await figureFrame(page);

  // --- Keyboard activation: Tab reaches the control and Enter opens ----------
  assert.equal(await tabTo(page, '[data-graph-activate]'), true, 'the activate control was not reachable by Tab');
  await page.keyboard.press('Enter');
  await waitForStatus(
    page,
    filled(translate('en').graphExplorerStatusLocal, { shown: HUB_STATIC.shown, total: HUB_STATIC.total }),
  );

  assert.deepEqual(await drawnSlugs(page), [...HUB_LOCAL_DRAWN], 'the drawn neighbour set or its order is wrong');
  assert.equal(
    await region.locator('.graph-table tbody tr').count(),
    HUB_STATIC.tableRows,
    'the live table does not match the live figure',
  );

  // The static count sentences are retired with the drawing they described: the
  // bound paragraph still states "12 of 17" for the build-time figure, and the
  // empty-filter and stale-name variants are gated below.
  assert.equal(
    await region.locator('[data-graph-figure-label]').isVisible(),
    false,
    'the stale static count label is still shown beside the live graph',
  );
  assert.equal(
    await region.locator('.graph-bound span').isVisible(),
    false,
    'the static bound sentence still states a count beside the live status',
  );
  const liveName = await page.locator('svg.graph-svg').getAttribute('aria-label');
  assert.ok(liveName && !/\d/.test(liveName), `the live figure name still carries counts: ${liveName}`);

  // --- Every row's re-center control names its note ---------------------------
  // The visible text is one word on every row, so the accessible name is the
  // only per-row label; it is read against the page's own emitted template and
  // the hand-written title, and the control count has to follow the drawn rows
  // (the subject included) while `/graph/` offers none at all.
  const recenterTemplate = await page.locator('[data-graph-controls]').getAttribute('data-graph-recenter-label');
  assert.ok(recenterTemplate, 'the page does not emit the re-center label template');
  assert.equal(
    await region.locator('[data-graph-recenter="peer-01"]').getAttribute('aria-label'),
    filled(recenterTemplate!, { title: peerTitle('peer-01') }),
    'a re-center control does not name the note it acts on',
  );
  assert.equal(
    await region.locator('button[data-graph-recenter]').count(),
    HUB_STATIC.tableRows,
    'the live table does not offer one re-center control per drawn row',
  );

  // --- The live table's cells against hand values -----------------------------
  // The table is the equivalent representation, so its cells are read as
  // themselves and not only as anchors: the relationship word, the drawn
  // degree, and the joined list in its title order. The numbers are the
  // hand-written `HUB_TABLE` oracle; the words come from the page's own
  // translation templates, never from the rendered cell.
  const rows = await liveTableRows(page);
  assert.equal(rows.length, HUB_TABLE.rows, 'the live table does not hold one row per drawn node');
  const rowFor = (slug: string): LiveTableRow => {
    const row = rows.find((candidate) => candidate.note === `/notes/${slug}/`);
    if (row === undefined) throw new Error(`the live table has no row for ${slug}`);
    return row;
  };
  assert.equal(
    rowFor('hub').relation,
    translate('en').graphSubjectRelation,
    'the subject row does not state the subject relationship',
  );
  assert.equal(rowFor('hub').degree, String(HUB_TABLE.hub.degree), 'the subject row degree is not its drawn line count');
  assert.equal(
    rowFor('peer-01').relation,
    translate('en').graphOutgoingRelation,
    'a neighbouring row sent to by the subject does not state the outgoing relationship',
  );
  assert.equal(
    rowFor('peer-01').degree,
    String(HUB_TABLE['peer-01'].degree),
    'peer-01 degree is not its three merged lines',
  );
  assert.deepEqual(
    rowFor('peer-01').joined.map((href) => href.replace(/^\/notes\/|\/$/g, '')),
    [...HUB_TABLE['peer-01'].joined],
    'the joined list is not the drawn edge set in title order',
  );

  // The degree-1 template is a different string from the plural one, so an
  // exact comparison against the hand-filled singular template pins which one
  // the client chose; an `includes` check could pass on either.
  const oneLink = await page.locator('.graph-nodes a[href="/notes/peer-05/"]').getAttribute('aria-label');
  assert.equal(
    oneLink,
    filled(translate('en').graphExplorerNodeLabelOne, {
      title: peerTitle('peer-05'),
      relation: translate('en').graphOutgoingRelation,
      degree: 1,
    }),
    `a degree-1 node does not use the singular accessible-name template: ${oneLink}`,
  );

  const edges = await parsedEdges(page);
  assert.deepEqual(
    edges.map(({ from, to, mutual, incoming }) => ({ from, to, mutual, incoming })),
    [...HUB_LOCAL_EDGES],
    'the merged edge set, its direction, or its classes are wrong',
  );
  assert.equal(edges.length, HUB_LOCAL_EDGES.length, 'a stale or extra edge line survived the redraw');
  for (const edge of edges) {
    assert.equal(edge.markerEnd, true, `an edge has no arrowhead at its target: ${JSON.stringify(edge)}`);
    assert.equal(edge.markerStart, edge.mutual, `marker-start does not track mutuality: ${JSON.stringify(edge)}`);
  }
  // The two properties the mutations target: the neighbour-to-neighbour edges
  // are present (peer-01<->peer-02, peer-02->peer-03, peer-03->peer-01,
  // peer-04->peer-02) and nothing to an omitted neighbour is.
  assert.ok(
    edges.some((edge) => edge.from === 'peer-03' && edge.to === 'peer-01'),
    'the cycle edge peer-03 -> peer-01 is missing',
  );
  assert.ok(
    !edges.some((edge) => edge.from === 'hub' && edge.to === 'peer-13'),
    'an edge to an omitted neighbour is drawn',
  );

  // The relation word comes from the client's own lookup of the shared key, so
  // a renamed or dropped state shows up here as a missing word, not a blank.
  const label = await page.locator('.graph-nodes a[href="/notes/peer-01/"]').getAttribute('aria-label');
  assert.ok(label && label.includes('Peer 01'), 'a drawn node has no accessible name');
  assert.ok(
    label.includes(translate('en').graphOutgoingRelation),
    `a drawn node's accessible name does not state its relationship: ${label}`,
  );
  const subjectLabel = await page.locator('.graph-nodes a[href="/notes/hub/"]').getAttribute('aria-label');
  assert.ok(
    subjectLabel?.includes(translate('en').graphSubjectRelation),
    `the centre has no subject name: ${subjectLabel}`,
  );

  // --- Keyboard reset: the next control in the tab order, Space ---------------
  // A second Worker reply is the proof the control acted: asserting the picture
  // alone would pass on a renderer that ignored the click handler and left the
  // hub selection up.
  assert.equal(await tabTo(page, '[data-graph-reset-control]'), true, 'the reset control was not reachable by Tab');
  await page.keyboard.press('Space');
  await page.waitForFunction(
    () => {
      const replies = (window as unknown as { __graphReplies: { ok?: boolean; result?: { type?: string } }[] })
        .__graphReplies;
      return replies.filter((reply) => reply.ok && reply.result?.type === 'localGraph').length === 2;
    },
    undefined,
    { timeout: 20_000 },
  );
  assert.deepEqual(await drawnSlugs(page), [...HUB_LOCAL_DRAWN], 'reset did not restore the origin selection');
  assert.equal(
    (await page.locator('[data-graph-status]').textContent()) ?? '',
    filled(translate('en').graphExplorerStatusLocal, { shown: HUB_STATIC.shown, total: HUB_STATIC.total }),
    'reset changed the status of the origin selection',
  );

  // --- Keyboard re-centre, then the rest of the cycle by click ----------------
  await page.locator('.graph-table').evaluate((details: HTMLDetailsElement) => {
    details.open = true;
  });

  const observed = [await drawnSlugs(page)];
  let frameChecked = false;
  for (const [index, step] of RECENTER_SEQUENCE.slice(1).entries()) {
    if (index === 0) {
      assert.equal(
        await tabTo(page, `[data-graph-recenter="${step.center}"]`),
        true,
        'a re-center control was not reachable by Tab',
      );
      await page.keyboard.press('Space');
    } else {
      await page.locator(`[data-graph-recenter="${step.center}"]`).first().click();
    }
    await waitForCenter(page, step.center!);

    if (index === 0) {
      // The activated button is gone with the rows it lived in, so the client
      // has to move focus to the same note's new control; otherwise a keyboard
      // reader lands back at the top of the document after one re-center.
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute('data-graph-recenter')),
        step.center,
        'focus did not follow the re-center control that was activated',
      );
    }

    if (!frameChecked && step.center === 'peer-02') {
      // A re-center replaces the figure's contents, so the SVG's own frame and
      // accessible name have to move with them: peer-02 has fewer neighbours than
      // hub, so the old frame would draw the new selection small inside it, and the
      // static count-bearing name would read a second total beside the live status.
      frameChecked = true;
      const recentered = await figureFrame(page);
      assert.ok(
        recentered.boxWidth < staticFrame.boxWidth,
        `the redrawn selection kept the static frame: ${recentered.viewBox}`,
      );
      assertFrameCovers(recentered);
      assert.notEqual(recentered.label, staticFrame.label, 'the figure kept the static selection name');
      assert.ok(!/\d/.test(recentered.label), `the live figure name still carries counts: ${recentered.label}`);
      assert.equal(
        recentered.label,
        await page.locator('[data-graph-controls]').getAttribute('data-graph-figure-name'),
        'the live figure name is not the count-free name the page emitted',
      );
      assert.equal(
        await page.locator('[data-graph-figure-label]').isVisible(),
        false,
        'the stale static count label is still shown beside the live graph',
      );
    }
    observed.push(await drawnSlugs(page));

    if (step.center === 'peer-01') {
      // peer-01's selection is the one where lines arrive as well as leave:
      // hub -> peer-01 and peer-03 -> peer-01 are incoming, while the hub
      // selection's oracle has no incoming line to lose. Parsed lines,
      // direction classes, and both marker ends are compared against the
      // hand-computed merged set, so a dropped `graph-edge-incoming` class
      // cannot stay green.
      assert.deepEqual(
        await parsedEdges(page),
        [...PEER01_LOCAL_EDGES],
        'the peer-01 merged edge set, direction classes, or marker ends are wrong',
      );
    }
  }

  assert.deepEqual(observed, RECENTER_SEQUENCE.map((step) => [...step.drawn]), 'a re-centre drew the wrong selection');
  for (const [index, drawn] of observed.entries()) {
    assert.ok(drawn.length <= 13, `step ${index} drew ${drawn.length} nodes: the bound is not enforced`);
  }

  // One shared Worker: the snapshot, WASM, and Worker chunk are each requested
  // once, the Worker is never terminated, and never re-created. Activation, the
  // reset, every re-center, and the preview below all post through it.
  const replies = (await graphReplies(page)).filter((reply) => reply.ok && reply.result?.type === 'localGraph');
  assert.deepEqual(
    replies.map((reply) => reply.result?.graph?.center?.slug),
    [...HUB_REPLY_CENTERS],
    'a re-centre was redrawn without a new Worker response',
  );

  // A hover preview on the same page shares the runtime the drawing used.
  const link = page
    .locator('aside[aria-labelledby="outgoing-title"] .relations-list a[href="/notes/peer-02/"]')
    .first();
  await link.hover();
  await page.locator('#link-preview').waitFor({ state: 'visible', timeout: 15_000 });
  const preview = (await page.locator('#link-preview').textContent()) ?? '';
  assert.ok(preview.includes('Peer 02'), `the preview did not name the hovered note: ${preview}`);

  assert.deepEqual(
    assetCounts(requests),
    { db: 1, wasm: 1, glue: 1, worker: 1 },
    'activation, re-centering, or the preview re-downloaded or re-created the runtime',
  );
  assert.equal(await workerTerminations(page), 0, 'the page replaced its Worker instead of sharing it');
  assert.equal(await workerCreations(page), 1, 'the shared Worker was constructed more than once');
  assert.deepEqual(errors, [], 'the shared runtime produced a page error');

  // The render instrument stays silent on an ordinary page: the listener was
  // present from the first script, so zero events means the client checked the
  // flag rather than that nobody was listening.
  assert.deepEqual(
    await page.evaluate(() => (window as unknown as { __quietRenderEvents: unknown[] }).__quietRenderEvents),
    [],
    'an unarmed page dispatched the render measurement',
  );

  // No request on this page asked to measure, so no reply may carry the
  // measurement-only fields. `recordWorkerActivity` captures the raw reply
  // rather than the client's filtered view, so this is the Worker's own answer:
  // adding measured fields to an ordinary request would be the behavior change
  // this instrumentation must not make.
  const unmeasured = await graphReplies(page);
  assert.ok(unmeasured.length > 0, 'the unarmed page produced no Worker replies to inspect');
  for (const reply of unmeasured) {
    assert.equal('sqlMs' in reply, false, `an unmeasured reply carried sqlMs: ${JSON.stringify(reply)}`);
    assert.equal('phases' in reply, false, `an unmeasured reply carried phases: ${JSON.stringify(reply)}`);
  }
  await page.close();
}, 120_000);

// --- Global ranking, filters, and honest display ---------------------------------

test('the global graph ranks 60 of 65, filters team and garden exactly, depicts an empty filter, and resets', async () => {
  const page = await browser.newPage();
  await page.goto(`${site.origin}/graph/`, { waitUntil: 'load' });
  const staticFrame = await figureFrame(page);
  const region = page.locator('[data-graph-region="site-graph"]');
  await page.locator('[data-graph-activate]').click();
  await page.waitForFunction(() => (document.querySelector('[data-graph-status]')?.textContent ?? '').length > 0);

  const unfiltered = await drawnSlugs(page);
  assert.deepEqual(unfiltered, [...GLOBAL_DRAWN], 'the unfiltered ranking or the drawn set is wrong');
  assert.equal(unfiltered[0], 'hub', 'the unfiltered graph does not start at the most linked note');
  assert.equal(
    await region.locator('button[data-graph-recenter]').count(),
    0,
    'the global graph offers a re-center control that would center on nothing',
  );
  assert.equal(
    (await page.locator('[data-graph-status]').textContent()) ?? '',
    filled(translate('en').graphExplorerStatusGlobal, { shown: GLOBAL_DRAWN.length, total: CORPUS_SIZE }),
  );

  // The omitted slugs are read back as the corpus minus the drawing, and the
  // exact five are the hand-listed lowest-ranked entries.
  const drawnSet = new Set(unfiltered);
  const missing = CORPUS_SLUGS.filter((slug) => !drawnSet.has(slug));
  assert.deepEqual([...missing].sort(), [...GLOBAL_OMITTED].sort(), 'the omitted slugs are not the ranked tail');

  await page.selectOption('[data-graph-tag]', 'team');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.graph-nodes a.graph-node').length === 3 &&
      document.querySelector('.graph-nodes a.graph-node')?.getAttribute('href') === '/notes/peer-01/',
  );
  assert.deepEqual(await drawnSlugs(page), [...TEAM_DRAWN], 'the team filter is not its in-tag rank order');
  assert.equal(await page.locator('.graph-edges line').count(), TEAM_EDGE_COUNT, 'the team subgraph edge count is wrong');
  assert.equal(
    await region.locator('.graph-table tbody tr').count(),
    TEAM_DRAWN.length,
    'the live table still holds the unfiltered rows under a filtered figure',
  );
  assert.ok(!(await drawnSlugs(page)).includes('hub'), 'the tag filter drew an outside endpoint');
  assert.equal(
    (await page.locator('[data-graph-status]').textContent()) ?? '',
    filled(translate('en').graphExplorerStatusFiltered, { tag: 'team', shown: 3, total: 3 }),
  );

  await page.selectOption('[data-graph-tag]', 'garden');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.graph-nodes a.graph-node').length === 3 &&
      document.querySelector('.graph-nodes a.graph-node')?.getAttribute('href') === '/notes/island/',
  );
  assert.deepEqual(await drawnSlugs(page), [...GARDEN_DRAWN], 'the garden filter is not its title order');
  assert.equal(await page.locator('.graph-edges line').count(), GARDEN_EDGE_COUNT, 'the garden subgraph has an edge');
  assert.equal(
    await region.locator('.graph-table tbody tr').count(),
    GARDEN_DRAWN.length,
    'the live table still holds the team rows under the garden figure',
  );
  assert.equal(
    (await page.locator('[data-graph-status]').textContent()) ?? '',
    filled(translate('en').graphExplorerStatusFiltered, { tag: 'garden', shown: 3, total: 3 }),
  );

  // The filtered top-ranked note is not the unfiltered one, which is what makes
  // the filter a filter rather than a repaint of the same ranking.
  const garden = await drawnSlugs(page);
  assert.equal(garden[0], 'island', 'the isolated garden member did not rank first in its own filter');
  assert.notEqual(garden[0], unfiltered[0], 'the filtered top-ranked note is the unfiltered top');

  // The filter draws three notes where the static figure draws the whole
  // corpus, so the static frame would shrink them and the static name would
  // contradict the live count sentence.
  const filteredFrame = await figureFrame(page);
  assert.ok(
    filteredFrame.boxWidth < staticFrame.boxWidth,
    `the filtered graph kept the static frame: ${filteredFrame.viewBox}`,
  );
  assertFrameCovers(filteredFrame);
  assert.notEqual(filteredFrame.label, staticFrame.label, 'the figure kept the static selection name');
  assert.ok(!/\d/.test(filteredFrame.label), `the live figure name still carries counts: ${filteredFrame.label}`);
  assert.equal(
    filteredFrame.label,
    await page.locator('[data-graph-controls]').getAttribute('data-graph-figure-name'),
    'the live figure name is not the count-free name the page emitted',
  );
  assert.equal(
    await page.locator('[data-graph-figure-label]').isVisible(),
    false,
    'the stale static count label is still shown beside the live graph',
  );

  // An empty filter is not a runtime failure, and it is not a stale picture
  // either: the status sentence and the drawing must say the same thing.
  await page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>('[data-graph-tag]')!;
    select.append(new Option('empty-tag', 'empty-tag'));
    select.value = 'empty-tag';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitForStatus(page, translate('en').graphExplorerEmptyFilter);
  assert.equal(
    await region.locator('.graph-nodes a.graph-node').count(),
    0,
    'the previous selection is still drawn under an empty-filter status',
  );
  assert.equal(
    await region.locator('.graph-table tbody tr').count(),
    0,
    'the previous selection still has table rows under an empty-filter status',
  );
  assert.equal(await page.locator('.graph-edges line').count(), 0, 'the previous selection still has edges');

  await page.locator('[data-graph-reset-control]').click();
  await page.waitForFunction(
    () => document.querySelector('.graph-nodes a.graph-node')?.getAttribute('href') === '/notes/hub/',
  );
  assert.deepEqual(await drawnSlugs(page), [...GLOBAL_DRAWN], 'reset did not restore the unfiltered graph');
  assert.equal(
    (await page.locator('[data-graph-status]').textContent()) ?? '',
    filled(translate('en').graphExplorerStatusGlobal, { shown: GLOBAL_DRAWN.length, total: CORPUS_SIZE }),
    'reset did not restore the unfiltered status',
  );
  await page.close();
}, 120_000);

test('a first-load empty filter depicts emptiness, not the unfiltered baseline', async () => {
  const page = await browser.newPage();
  await page.goto(`${site.origin}/graph/`, { waitUntil: 'load' });
  const region = page.locator('[data-graph-region="site-graph"]');
  assert.ok(
    (await region.locator('.graph-nodes a.graph-node').count()) > 0,
    'the static global figure is empty, so this gate would assert nothing',
  );

  // No activation first: the chooser is live before the explorer is, so the
  // first query this page ever makes is the empty filter.
  await page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>('[data-graph-tag]')!;
    select.append(new Option('empty-tag', 'empty-tag'));
    select.value = 'empty-tag';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitForStatus(page, translate('en').graphExplorerEmptyFilter);
  assert.equal(
    await region.locator('.graph-nodes a.graph-node').count(),
    0,
    'the unfiltered static baseline still stands under an empty-filter status',
  );
  assert.equal(
    await region.locator('.graph-table tbody tr').count(),
    0,
    'the unfiltered static table still stands under an empty-filter status',
  );
  // The static count surfaces belong to the drawing that was cleared, so the
  // empty result cannot carry the unfiltered totals beside it.
  assert.equal(
    await region.locator('[data-graph-figure-label]').isVisible(),
    false,
    'the static count label survives under an empty-filter status',
  );
  assert.equal(
    await region.locator('.graph-bound span').isVisible(),
    false,
    'the static bound sentence survives under an empty-filter status',
  );
  const emptyName = await page.locator('svg.graph-svg').getAttribute('aria-label');
  assert.ok(emptyName && !/\d/.test(emptyName), `the emptied figure keeps a count-bearing name: ${emptyName}`);
  await page.close();
}, 120_000);

test("an unknown center is a no-match, not a failure, and keeps the stale page's baseline", async () => {
  const page = await browser.newPage();
  await recordWorkerActivity(page);
  // Simulate a stale binding: this page was built when `hub` was published, and
  // the snapshot the document now binds to does not contain it. Only the page's
  // own input changes; the Worker, the snapshot, and the reply are real.
  await page.route('**/notes/hub/', async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/data-graph-center="[^"]*"/, 'data-graph-center="ghost-note"');
    await route.fulfill({ response, body });
  });
  await page.goto(`${site.origin}/notes/hub/`, { waitUntil: 'load' });
  const region = page.locator('[data-graph-region="note-graph"]');
  const staticNodes = await region.locator('.graph-nodes a.graph-node').count();
  assert.ok(staticNodes > 0, 'the stale page has no baseline to preserve');

  await page.locator('[data-graph-activate]').click();
  await waitForStatus(page, translate('en').graphExplorerUnknownCenter);
  assert.notEqual(
    await page.locator('[data-graph-status]').textContent(),
    translate('en').graphExplorerFailed,
    'an unknown center was reported as a runtime failure',
  );
  assert.equal(
    await region.locator('.graph-nodes a.graph-node').count(),
    staticNodes,
    'the unknown center blanked the baseline it never replaced',
  );
  assert.equal(await region.locator('.graph-table tbody tr').count(), HUB_STATIC.tableRows);
  // The baseline was never replaced, so its count sentences are still the truth
  // about what is on screen and must not have been hidden with a live drawing.
  assert.equal(
    await region.locator('[data-graph-figure-label]').isVisible(),
    true,
    'the unknown-center no-match hid the baseline counts it preserved',
  );

  // The distinct no-match answer really crossed the Worker boundary: an ok reply
  // whose localGraph result is null, not a rejected request.
  const replies = (await graphReplies(page)).filter((reply) => reply.ok && reply.result?.type === 'localGraph');
  assert.equal(replies.length, 1, 'the Worker did not answer the unknown lookup');
  assert.equal(replies[0]!.result!.graph, null, 'the unknown center was not a no-match result');
  await page.close();
}, 120_000);

test('the armed render instrument reports the live drawing with its scope', async () => {
  const armed = await browser.newPage();
  await recordWorkerActivity(armed);
  await armed.addInitScript(() => {
    (window as unknown as { __snapshotMeasurement?: boolean }).__snapshotMeasurement = true;
    (window as unknown as { __graphRenderEvents: { scope: string; ms: number }[] }).__graphRenderEvents = [];
    document.addEventListener('graph-render', (event) => {
      (window as unknown as { __graphRenderEvents: { scope: string; ms: number }[] }).__graphRenderEvents.push(
        (event as CustomEvent<{ scope: string; ms: number }>).detail,
      );
    });
  });
  await armed.goto(`${site.origin}/notes/hub/`, { waitUntil: 'load' });
  await armed.locator('[data-graph-activate]').click();
  await waitForStatus(
    armed,
    filled(translate('en').graphExplorerStatusLocal, { shown: HUB_STATIC.shown, total: HUB_STATIC.total }),
  );
  const events = await armed.evaluate(
    () => (window as unknown as { __graphRenderEvents: { scope: string; ms: number }[] }).__graphRenderEvents,
  );
  assert.equal(events.length, 1, 'one drawing did not produce exactly one render measurement');
  assert.equal(events[0]!.scope, 'local', 'the render measurement named the wrong scope');
  assert.ok(
    Number.isFinite(events[0]!.ms) && events[0]!.ms > 0,
    `the render duration is not a positive finite measurement: ${events[0]!.ms}`,
  );

  // The same drawing crossed the shipped Worker, so the reply's own span is a
  // real measurement rather than a stub: a regression that drops, zeroes, or
  // mis-scopes `operationMs` would leave goal 0008 with a fabricated number.
  const measured = (await graphReplies(armed)).filter((reply) => reply.ok && reply.result?.type === 'localGraph');
  assert.equal(measured.length, 1, 'the armed drawing has no real Worker reply to measure');
  const reply = measured[0]!;
  assert.ok(
    typeof reply.operationMs === 'number' && Number.isFinite(reply.operationMs) && reply.operationMs > 0,
    `the Worker operation span is not a positive finite measurement: ${String(reply.operationMs)}`,
  );

  // The measured request additionally gets the inner-SQL sum and the startup
  // decomposition from the real shipped Worker. `sqlMs` is a subset of the
  // `operationMs` span that contains it, and the phases cannot exceed their own
  // total; both cross the boundary as plain numbers.
  assert.ok(
    typeof reply.sqlMs === 'number' && Number.isFinite(reply.sqlMs) && reply.sqlMs >= 0,
    `the inner-SQL figure is not a finite non-negative measurement: ${String(reply.sqlMs)}`,
  );
  assert.ok(
    reply.sqlMs <= reply.operationMs,
    `the inner-SQL sum (${reply.sqlMs}) exceeds the operation span (${reply.operationMs}) that contains it`,
  );
  const phases = reply.phases;
  assert.ok(phases !== undefined, 'the measured reply carried no startup phase decomposition');
  for (const field of ['totalMs', 'fetchMs', 'digestMs', 'wasmInitMs', 'importMs'] as const) {
    assert.ok(
      typeof phases[field] === 'number' && Number.isFinite(phases[field]) && phases[field] >= 0,
      `startup phase ${field} is not a finite non-negative measurement: ${String(phases[field])}`,
    );
  }
  assert.ok(
    phases.totalMs >= Math.max(phases.fetchMs, phases.digestMs, phases.wasmInitMs, phases.importMs),
    `a phase outran the total that contains it: ${JSON.stringify(phases)}`,
  );
  // The pinned WASM module exposes `config.memory` (a `WebAssembly.Memory`), so
  // the capacity is a real positive byte count here. A future pin that stops
  // exposing it makes the Worker report the documented `null`; this gate then
  // fails, so that change has to be recorded rather than silently degrading.
  assert.ok(
    typeof phases.wasmMemoryBytes === 'number' && phases.wasmMemoryBytes > 0,
    `wasmMemoryBytes is not a positive byte count: ${String(phases.wasmMemoryBytes)}`,
  );
  assert.ok(Number.isInteger(phases.wasmMemoryBytes), 'wasmMemoryBytes is not an integral byte capacity');
  await armed.close();
}, 120_000);

// --- Mixed-language expansion ----------------------------------------------------

test('a live redraw preserves the static lang attributes of both pages', async () => {
  const events = [
    {
      url: '/notes/peer-01/',
      expected: {
        drawn: PEER01_DRAWN,
        figure: PEER01_FIGURE_LANGS,
        table: PEER01_TABLE_LANGS,
        status: filled(translate('en').graphExplorerStatusLocal, { shown: 4, total: 4 }),
      },
    },
    {
      url: '/notes/zh-note/',
      expected: {
        drawn: ZH_NOTE_DRAWN,
        figure: ZH_NOTE_FIGURE_LANGS,
        table: ZH_NOTE_TABLE_LANGS,
        status: filled(translate('zh-CN').graphExplorerStatusLocal, { shown: 2, total: 2 }),
      },
    },
  ] as const;

  for (const { url, expected } of events) {
    const page = await browser.newPage();
    await page.goto(`${site.origin}${url}`, { waitUntil: 'load' });
    const figureScope = '[data-graph-region="note-graph"] .graph-nodes';
    const tableScope = '[data-graph-region="note-graph"] .graph-table tbody';

    // The static page is the oracle for the live one: the same language marks
    // have to survive the redraw, and both have to match the hand list. The
    // hand list itself pins `zh-CN` on the Chinese title, so comparing two
    // equally unmarked sets cannot pass.
    assert.deepEqual(await anchorLanguages(page, figureScope), [...expected.figure], `static figure langs on ${url}`);
    assert.deepEqual(await anchorLanguages(page, tableScope), [...expected.table], `static table langs on ${url}`);

    await page.locator('[data-graph-activate]').click();
    await page.waitForFunction(() => (document.querySelector('[data-graph-status]')?.textContent ?? '').length > 0);
    assert.deepEqual(await drawnSlugs(page), [...expected.drawn], `the drawn set on ${url}`);

    const liveFigure = await anchorLanguages(page, figureScope);
    const liveTable = await anchorLanguages(page, tableScope);
    assert.deepEqual(liveFigure, [...expected.figure], `the live figure langs changed on ${url}`);
    assert.deepEqual(liveTable, [...expected.table], `the live table langs changed on ${url}`);

    // The redraw carries the note's own text and name, not only its language:
    // the zh-note anchor's visible text is exactly the corpus's Chinese title,
    // and its accessible name repeats that title. A redraw that wrote a slug,
    // an empty label, or the wrong note's title fails here while the language
    // comparison above still passes.
    const zhAnchor = page.locator(`${figureScope} a[href="/notes/zh-note/"]`);
    assert.equal(await zhAnchor.count(), 1, `the live figure does not hold one zh-note anchor on ${url}`);
    assert.equal(await zhAnchor.textContent(), ZH_NOTE_TITLE, `the live zh-note label is not the corpus title on ${url}`);
    const zhLabel = await zhAnchor.getAttribute('aria-label');
    assert.ok(
      zhLabel !== null && zhLabel.includes(ZH_NOTE_TITLE),
      `the live zh-note accessible name omits its title on ${url}: ${zhLabel}`,
    );

    assert.equal((await page.locator('[data-graph-status]').textContent()) ?? '', expected.status);
    await page.close();
  }
}, 180_000);

// --- Failure, sharing, and termination -------------------------------------------

test('a blocked wasm download keeps the static page and recovers when it is served again', async () => {
  const page = await browser.newPage();
  const errors = collectPageErrors(page);
  await page.route('**/*.wasm', (route) => route.abort());
  await page.goto(`${site.origin}/notes/hub/`, { waitUntil: 'load' });

  const region = page.locator('[data-graph-region="note-graph"]');
  const staticNodes = await region.locator('.graph-nodes a.graph-node').count();
  const staticRows = await region.locator('.graph-table tbody tr').count();
  const staticOutgoing = await page.locator('aside[aria-labelledby="outgoing-title"] .relations-list a').count();

  await page.locator('[data-graph-activate]').click();
  await waitForStatus(page, translate('en').graphExplorerFailed);
  assert.equal(await region.locator('.graph-nodes a.graph-node').count(), staticNodes, 'the static figure was lost');
  assert.equal(await region.locator('.graph-table tbody tr').count(), staticRows, 'the static table was lost');
  assert.equal(await region.locator('.graph-nodes a[href="/notes/peer-01/"]').count(), 1, 'a static node link was lost');
  assert.equal(
    await page.locator('aside[aria-labelledby="outgoing-title"] .relations-list a').count(),
    staticOutgoing,
    'the static outgoing list was lost',
  );

  await page.unroute('**/*.wasm');
  await page.locator('[data-graph-activate]').click();
  await waitForStatus(
    page,
    filled(translate('en').graphExplorerStatusLocal, { shown: 12, total: 17 }),
    30_000,
  );
  assert.deepEqual(await drawnSlugs(page), [...HUB_LOCAL_DRAWN], 'retry after the wasm restore did not draw');
  assert.deepEqual(errors, [], 'the failure path threw past its caller');
  await page.close();
}, 120_000);

test('a Worker that stops replying is terminated at its deadline and the next intent creates a new one', async () => {
  const page = await browser.newPage();
  await countWorkerTerminations(page);
  await recordWorkerActivity(page);
  await page.goto(`${site.origin}/notes/hub/`, { waitUntil: 'load' });
  await page.locator('[data-graph-activate]').click();
  await page.waitForFunction(() => (document.querySelector('[data-graph-status]')?.textContent ?? '').length > 0);
  const drawn = await drawnSlugs(page);
  assert.equal(drawn.length, HUB_STATIC.figureNodes);

  // Drop every message after the first draw. The client's request deadline
  // (8 s once initialized) is the only bounded stop, and it terminates the
  // Worker rather than leaving a pending request forever.
  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    (window as unknown as { __restorePostMessage: () => void }).__restorePostMessage = () => {
      Worker.prototype.postMessage = original;
    };
    Worker.prototype.postMessage = () => {};
  });

  await page.locator('[data-graph-activate]').click();
  await page.waitForFunction(() => (window as unknown as { __terminateCount: number }).__terminateCount >= 1, undefined, {
    timeout: 20_000,
  });
  await waitForStatus(page, translate('en').graphExplorerFailed);
  assert.equal(await workerTerminations(page), 1, 'the silent Worker was terminated more than once');
  assert.equal(
    await page.locator('[data-graph-region="note-graph"] .graph-nodes a.graph-node').count(),
    HUB_STATIC.figureNodes,
    'the deadline failure blanked the previously drawn figure',
  );
  assert.equal(
    await page.locator('[data-graph-region="note-graph"] .graph-table tbody tr').count(),
    HUB_STATIC.tableRows,
    'the deadline failure blanked the previously drawn table',
  );

  await page.evaluate(() => (window as unknown as { __restorePostMessage: () => void }).__restorePostMessage());
  await page.locator('[data-graph-activate]').click();
  await waitForStatus(
    page,
    filled(translate('en').graphExplorerStatusLocal, { shown: HUB_STATIC.shown, total: HUB_STATIC.total }),
    30_000,
  );
  assert.deepEqual(await drawnSlugs(page), [...HUB_LOCAL_DRAWN], 'the retry after termination did not draw');
  assert.ok((await workerCreations(page)) >= 2, 'the retry reused the terminated Worker instead of creating a new one');
  await page.close();
}, 120_000);

// --- Stale replies ---------------------------------------------------------------

test('a released stale filter reply cannot overwrite the newer filter', async () => {
  const page = await browser.newPage();
  await recordWorkerActivity(page);
  await page.goto(`${site.origin}/graph/`, { waitUntil: 'load' });
  await page.locator('[data-graph-activate]').click();
  await page.waitForFunction(() => (document.querySelector('[data-graph-status]')?.textContent ?? '').length > 0);
  assert.equal((await drawnSlugs(page)).length, GLOBAL_DRAWN.length, 'the unfiltered graph did not draw first');

  // Hold the next globalGraph request: the Worker never sees it until the
  // test releases it, after a newer filter has already rendered.
  await page.evaluate(() => {
    const state = window as unknown as {
      __graphHold: {
        armed: boolean;
        message: { type?: string; tagKey?: string; id?: number } | null;
        worker: Worker | null;
        released: boolean;
      };
      __releaseHeld: () => void;
    };
    const original = Worker.prototype.postMessage;
    state.__graphHold = { armed: true, message: null, worker: null, released: false };
    Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]) {
      const hold = state.__graphHold;
      if (hold.armed && (message as { type?: string }).type === 'globalGraph') {
        hold.armed = false;
        hold.message = message as { type?: string; tagKey?: string; id?: number };
        hold.worker = this;
        return;
      }
      (original as (this: Worker, ...args: unknown[]) => void).call(this, message, ...rest);
    };
    state.__releaseHeld = () => {
      const hold = state.__graphHold;
      hold.released = true;
      (original as (this: Worker, ...args: unknown[]) => void).call(hold.worker!, hold.message!);
    };
  });

  await page.selectOption('[data-graph-tag]', 'team');
  const held = await page.evaluate(
    () =>
      (window as unknown as {
        __graphHold: { armed: boolean; message: { type?: string; tagKey?: string; id?: number } | null; released: boolean };
      }).__graphHold,
  );
  assert.equal(held.armed, false, 'the team request was not held');
  assert.equal(held.message?.type, 'globalGraph', 'the held message is not a globalGraph request');
  assert.equal(held.message?.tagKey, 'team', 'the held request is not the team filter');

  // A newer filter renders while the team request is still in the test's hand.
  await page.selectOption('[data-graph-tag]', 'garden');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.graph-nodes a.graph-node').length === 3 &&
      document.querySelector('.graph-nodes a.graph-node')?.getAttribute('href') === '/notes/island/',
  );
  const gardenDrawn = await drawnSlugs(page);

  await page.evaluate(() => (window as unknown as { __releaseHeld: () => void }).__releaseHeld());
  assert.equal(
    await page.evaluate(() => (window as unknown as { __graphHold: { released: boolean } }).__graphHold.released),
    true,
    'the held request was not the one released',
  );
  await page.waitForFunction(() => {
    const replies = (window as unknown as { __graphReplies: { result?: { type?: string } }[] }).__graphReplies;
    return replies.filter((reply) => reply.result?.type === 'globalGraph').length === 3;
  }, undefined, { timeout: 10_000 });

  // The consumed reply is a real team drawing; the sequence guard is what keeps
  // it off the screen.
  const replies = (await graphReplies(page)).filter((reply) => reply.ok && reply.result?.type === 'globalGraph');
  assert.deepEqual(
    replies.at(-1)?.result?.graph?.nodes?.map((node) => node.slug),
    [...TEAM_DRAWN],
    'the released reply is not the held team request',
  );
  assert.deepEqual(await drawnSlugs(page), gardenDrawn, 'the stale team reply overwrote the garden drawing');
  assert.equal(
    (await page.locator('[data-graph-status]').textContent()) ?? '',
    filled(translate('en').graphExplorerStatusFiltered, { tag: 'garden', shown: 3, total: 3 }),
    'the stale team reply overwrote the garden status',
  );
  await page.close();
}, 120_000);

test('a released stale center reply cannot overwrite the newer center', async () => {
  const page = await browser.newPage();
  await recordWorkerActivity(page);
  await page.goto(`${site.origin}/notes/hub/`, { waitUntil: 'load' });
  await page.locator('[data-graph-activate]').click();
  await waitForStatus(
    page,
    filled(translate('en').graphExplorerStatusLocal, { shown: HUB_STATIC.shown, total: HUB_STATIC.total }),
  );
  assert.deepEqual(await drawnSlugs(page), [...HUB_LOCAL_DRAWN], 'the origin selection did not draw first');

  // Hold the next localGraph request: the Worker never sees the peer-02
  // re-center until this test releases it, after a newer center has already
  // rendered. The filter gate above exercises the same sequence guard on the
  // global path; this one exercises it on a re-center, where the late reply
  // carries a different selection rather than a different tag.
  await page.evaluate(() => {
    const state = window as unknown as {
      __centerHold: { armed: boolean; message: unknown; worker: Worker | null };
      __releaseHeldCenter: () => void;
    };
    const original = Worker.prototype.postMessage;
    state.__centerHold = { armed: true, message: null, worker: null };
    Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]) {
      const hold = state.__centerHold;
      if (hold.armed && (message as { type?: string }).type === 'localGraph') {
        hold.armed = false;
        hold.message = message;
        hold.worker = this;
        return;
      }
      (original as (this: Worker, ...args: unknown[]) => void).call(this, message, ...rest);
    };
    state.__releaseHeldCenter = () => {
      const hold = state.__centerHold;
      (original as (this: Worker, ...args: unknown[]) => void).call(hold.worker!, hold.message);
    };
  });

  await page.locator('.graph-table').evaluate((details: HTMLDetailsElement) => {
    details.open = true;
  });
  await page.locator('[data-graph-recenter="peer-02"]').first().click();
  const held = await page.evaluate(
    () =>
      (window as unknown as {
        __centerHold: { armed: boolean; message: { type?: string; slug?: string } | null };
      }).__centerHold,
  );
  assert.equal(held.armed, false, 'the peer-02 request was not held');
  assert.equal(held.message?.type, 'localGraph', 'the held message is not a localGraph request');
  assert.equal(held.message?.slug, 'peer-02', 'the held request is not the peer-02 center');

  // A newer center renders while the peer-02 request is still in this test's
  // hand: peer-03's reply arrives and is drawn, from the hand-listed step.
  const peer03 = RECENTER_SEQUENCE[3]!;
  assert.equal(peer03.center, 'peer-03', 'the hand-listed sequence no longer holds peer-03 at this step');
  await page.locator('[data-graph-recenter="peer-03"]').first().click();
  await waitForCenter(page, peer03.center!);
  const drawn = await drawnSlugs(page);
  assert.deepEqual(drawn, [...peer03.drawn], 'the newer peer-03 center did not draw');

  await page.evaluate(() => (window as unknown as { __releaseHeldCenter: () => void }).__releaseHeldCenter());

  // Both replies exist: the newer peer-03 one was drawn, and the released
  // peer-02 one arrives after it. The sequence guard is what keeps the late
  // one off the screen; a client without it would flip the drawing back.
  await page.waitForFunction(
    () => {
      const replies = (window as unknown as { __graphReplies: { result?: { type?: string } }[] }).__graphReplies;
      return replies.filter((reply) => reply.result?.type === 'localGraph').length === 3;
    },
    undefined,
    { timeout: 10_000 },
  );
  const replies = (await graphReplies(page)).filter((reply) => reply.ok && reply.result?.type === 'localGraph');
  assert.deepEqual(
    replies.map((reply) => reply.result?.graph?.center?.slug),
    ['hub', 'peer-03', 'peer-02'],
    'the released reply is not the held peer-02 response, or a reply was dropped',
  );
  assert.deepEqual(await drawnSlugs(page), drawn, 'the stale peer-02 reply overwrote the peer-03 drawing');
  assert.equal(
    (await page.locator('[data-graph-status]').textContent()) ?? '',
    filled(translate('en').graphExplorerStatusLocal, { shown: 3, total: 3 }),
    'the stale peer-02 reply overwrote the peer-03 status',
  );
  await page.close();
}, 120_000);

// --- Existing surfaces under the new corpus --------------------------------------

test('a note with no neighbourhood offers no explorer that would draw nothing', async () => {
  const page = await browser.newPage();
  await page.goto(`${site.origin}/notes/island/`, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  assert.equal(
    await page.locator('.graph-region .empty-state').isVisible(),
    true,
    'the empty state is not shown',
  );
  // The explorer and its live status sentence are only offered where there is
  // a figure to enhance; otherwise the client would fill a count sentence for a
  // graph it has no canvas to draw.
  assert.equal(
    await page.locator('.graph-region [data-graph-controls]').count(),
    0,
    'the explorer was offered on a figure with nothing to draw',
  );
  assert.equal(
    await page.locator('.graph-region [data-graph-status]').count(),
    0,
    'a live status line was offered with nothing to draw',
  );
  await page.close();
}, 120_000);

test('a blocked snapshot leaves the static figure, table, and links intact', async () => {
  const page = await browser.newPage();
  await page.route('**/data/site.*', (route) => route.abort());
  await page.goto(`${site.origin}/notes/hub/`, { waitUntil: 'load' });
  const staticNodes = await page.locator('.graph-region .graph-nodes a.graph-node').count();
  const staticRows = await page.locator('.graph-region .graph-table tbody tr').count();
  await page.locator('[data-graph-activate]').click();
  await page.waitForTimeout(800);
  assert.match((await page.locator('[data-graph-status]').textContent()) ?? '', /could not|失败|complete/i);
  assert.equal(await page.locator('.graph-region .graph-nodes a.graph-node').count(), staticNodes, 'the static figure was lost');
  assert.equal(await page.locator('.graph-region .graph-table tbody tr').count(), staticRows, 'the static table was lost');
  assert.equal(await page.locator('.graph-region .graph-nodes a[href="/notes/peer-01/"]').count(), 1, 'a static node link was lost');
  await page.close();
}, 120_000);
