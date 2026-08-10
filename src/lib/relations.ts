/**
 * Derived relationships: what a note is *near*, when nothing links it there.
 *
 * The artifact carries two authored edge sets — `outgoing` and `backlinks` —
 * and `checkCorpus` proves they are exact inverses of each other. Everything in
 * this module is the other kind of relationship: not an edge somebody wrote,
 * but an adjacency computed from public metadata. The two must never be
 * confused on the page, which is why they render under separate headings and
 * why the derived list says on its face that it is derived.
 *
 * Pure, like `routes.ts`: nothing here imports the artifact. Callers pass the
 * corpus in, so every rule below is exercisable against synthetic fixtures
 * without building the site.
 */

import type { ContentEntry } from './schema.ts';
import { collectionFacets, tagFacets, type Facet } from './routes.ts';

/**
 * Total order over notes: title, then the unique slug so no tie is left open.
 *
 * The same order `routes.ts` sorts a facet's notes by. Restated rather than
 * exported from there because TK-08 is editing that file in parallel; the two
 * are asserted to agree in `tests/relations.test.ts`, which sorts a facet's own
 * entries with this comparator and requires the result to be unchanged. If they
 * ever diverge, that gate fails rather than the pager quietly disagreeing with
 * the collection index it walks.
 */
export function byTitleThenSlug(a: ContentEntry, b: ContentEntry): number {
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.slug < b.slug ? -1 : 1;
}

/**
 * Resolve an edge list to the notes it names, in a stable reader order.
 *
 * Requirements section 13.1 asks for a stable sort order. The artifact stores
 * both edge lists sorted by slug — which is what makes the corpus invariant
 * cheap to check and is meaningless to a reader, since a slug is a URL segment
 * and the reader is looking at titles. Sorting by title here is the display
 * decision; the artifact's order is unchanged.
 *
 * An unresolvable slug is skipped rather than rendered as a dead link.
 * `checkCorpus` already proves every edge resolves to a published entry, so
 * this is unreachable through the validated loader — but this function is pure
 * and fixture-driven, and a list of links must not depend on its caller having
 * validated first.
 */
export function notesForSlugs(
  slugs: readonly string[],
  lookup: (slug: string) => ContentEntry | undefined,
): ContentEntry[] {
  return slugs
    .map(lookup)
    .filter((entry): entry is ContentEntry => entry !== undefined)
    .sort(byTitleThenSlug);
}

/**
 * How many related notes a page may list.
 *
 * Requirements section 9.2 item 10 requires the list to be bounded, and the
 * number is chosen for the reader rather than for the data: a suggestion list
 * longer than this stops being a suggestion and becomes a second index of the
 * site, which the tag pages already are. Five also keeps the section inside one
 * screen at 320 px.
 */
export const RELATED_LIMIT = 5;

/**
 * The rule, in one sentence, for the reader.
 *
 * It lives beside the code it describes rather than in the template, because
 * the first version of this module shipped a page that stated a rule the
 * ranking did not implement: the prose said "rarest tag first" while the code
 * summed weights, so two middling tags beat one rare one. A string next to the
 * comparator is not proof they agree — `tests/relations.test.ts` proves that —
 * but it is what makes them move in the same commit, and a gate asserts the
 * page renders this exact text.
 */
export const RELATED_DERIVATION =
  'Suggested by shared tags, the tag grouping fewest notes first. ' +
  'Notes already listed above are excluded.';

/**
 * `tagFacets` for one corpus, computed once.
 *
 * Both functions below group the whole corpus by tag, and a static build calls
 * them once per note — so without this the grouping runs twice per page, which
 * measured **8.9 s** across a corpus at the `MAX_ENTRIES` ceiling of 900. With
 * it, 224 ms. That is a build-time cost only and nothing ships to a reader, but
 * seconds of build for a value that cannot change between two calls in the same
 * build is not a trade worth taking.
 *
 * A `WeakMap` keyed on the array a caller passed, rather than a module-level
 * variable: the fixture build, the published build, and the tests all evaluate
 * this module and pass *different* corpora, and a single cached value would
 * serve one build's grouping to another. Keying on the array means a distinct
 * corpus is a distinct entry, and a corpus nobody holds any more is collected.
 * This module stays pure — the same input still gives the same answer.
 */
const facetsByCorpus = new WeakMap<readonly ContentEntry[], Facet[]>();

function facetsFor(entries: readonly ContentEntry[]): Facet[] {
  const cached = facetsByCorpus.get(entries);
  if (cached !== undefined) return cached;
  const computed = tagFacets(entries);
  facetsByCorpus.set(entries, computed);
  return computed;
}

/** The published tag groups this note belongs to. */
function sharedFacets(entry: ContentEntry, entries: readonly ContentEntry[]): Facet[] {
  return facetsFor(entries).filter((facet) =>
    facet.entries.some((member) => member.slug === entry.slug),
  );
}

/**
 * Notes related to this one, most related first.
 *
 * **The rule.** A candidate is related when it shares at least one tag. It is
 * ranked by its **rarest shared tag**: the tag that groups the fewest notes,
 * with the smaller group ranking higher. Two candidates whose rarest shared tag
 * is the same size are ordered by how many tags they share, then by a shared
 * collection, then title, then slug.
 *
 * **Why the rarest tag rather than a sum of weights.** Summing per-tag rarity
 * was the first version and it is not the rule anyone would state: two tags of
 * 3 notes each outrank one tag of 2, so a candidate sharing several
 * middle-frequency tags beats the one candidate sharing the tag that actually
 * distinguishes this note. Taking the minimum makes the ranking say exactly
 * what the page says it says — a claim in prose that the code does not
 * implement is worse than a cruder rule.
 *
 * **Why rarity at all.** On the fixture corpus the tag `Field Notes` is on 20
 * of 32 notes. Ranking by a plain count of shared tags makes "related" mean
 * "also a note": measured on that corpus, `alias-heavy` and `undated-note-b`
 * take 21 of the 89 top-three placements between them — a quarter of every
 * suggestion on the site is one of two notes — because those two carry the two
 * commonest tags and nothing else. A tag that groups three notes should count
 * for more than one that groups two thirds of the site.
 *
 * **Why tags and not shared neighbours.** Shared neighbours were the other
 * candidate in the ticket. They are already on the page: the two sections above
 * this one render exactly the notes this one links to and is linked from, so a
 * derivation over the same edges would mostly restate them. Tags are the only
 * public grouping the artifact carries that the authored edges do not already
 * express. Shared collection is kept, but as a tiebreak rather than as a source
 * of candidates — a collection is coarse (three of them cover 28 of the 32
 * fixture notes), so as a source it would list arbitrary collection members as
 * "related".
 *
 * **What is excluded.** The note itself, and every note already named by
 * `outgoing` or `backlinks`. Those render immediately above, and suggesting a
 * page the reader can see two lines up is noise. That exclusion is what makes
 * this a *fallback* list rather than a third edge list — and it is why the
 * empty state must not claim nothing shares a tag: everything that does may
 * simply be linked already. {@link hasTagPeer} answers that question so the
 * page can say which of the two it is.
 *
 * Grouping comes from {@link tagFacets} rather than from a second pass over
 * `entry.tags`, so "shares a tag" means exactly what "appears on the same tag
 * page" means: `Gardening` and `gardening` are one tag here because they are
 * one tag there. A private second normalization would let a note be listed as
 * related on a tag the site never publishes.
 *
 * ponytail: the facets are recomputed per call, so a whole build is quadratic
 * in tag membership — at `MAX_ENTRIES` that is roughly two million set
 * operations across the build, well under a second. Hoist the facets into a
 * parameter if a build ever spends measurable time here.
 */
export function relatedNotes(entry: ContentEntry, entries: readonly ContentEntry[]): ContentEntry[] {
  const excluded = new Set([entry.slug, ...entry.outgoing, ...entry.backlinks]);
  const scored = new Map<string, { entry: ContentEntry; rarest: number; shared: number }>();

  for (const facet of sharedFacets(entry, entries)) {
    for (const candidate of facet.entries) {
      if (excluded.has(candidate.slug)) continue;
      const current = scored.get(candidate.slug);
      if (current === undefined) {
        scored.set(candidate.slug, { entry: candidate, rarest: facet.entries.length, shared: 1 });
      } else {
        current.rarest = Math.min(current.rarest, facet.entries.length);
        current.shared += 1;
      }
    }
  }

  const sharesCollection = (other: ContentEntry): boolean =>
    entry.collection !== undefined && other.collection === entry.collection;

  return [...scored.values()]
    .sort((a, b) => {
      if (a.rarest !== b.rarest) return a.rarest - b.rarest;
      if (a.shared !== b.shared) return b.shared - a.shared;
      const left = sharesCollection(a.entry);
      const right = sharesCollection(b.entry);
      if (left !== right) return left ? -1 : 1;
      return byTitleThenSlug(a.entry, b.entry);
    })
    .slice(0, RELATED_LIMIT)
    .map((candidate) => candidate.entry);
}

/**
 * Whether any other published note shares a tag with this one, linked or not.
 *
 * This is what separates the two reasons {@link relatedNotes} returns nothing.
 * A note with no tag-sharer at all genuinely has no neighbourhood; a note whose
 * every tag-sharer is already in `outgoing` or `backlinks` has one, and it is
 * rendered in the two sections above. Saying "nothing shares a tag" in the
 * second case would be a statement the artifact contradicts, which is exactly
 * what the empty states exist to avoid.
 */
export function hasTagPeer(entry: ContentEntry, entries: readonly ContentEntry[]): boolean {
  return sharedFacets(entry, entries).some((facet) =>
    facet.entries.some((member) => member.slug !== entry.slug),
  );
}

/** The notes either side of this one within its collection. */
export interface CollectionNeighbours {
  previous?: ContentEntry;
  next?: ContentEntry;
}

/**
 * The previous and next note in this note's collection.
 *
 * The sequence is {@link collectionFacets}' own order, which is the order
 * `/collections/<key>/` lists them in — title, then slug. Any other order would
 * put the pager and the collection index in disagreement, so a reader following
 * "Next" repeatedly would walk the collection in an order its own index does
 * not show. The artifact carries no authored sequence, so ordering by date
 * would be inventing a reading order the owner never expressed, and `collection`
 * is a flat slug with no nesting behind it — TK-05c owns hierarchy.
 *
 * A note with no collection, or the only note in one, has no sequence: both
 * fields are absent and the page renders no pager. That is the "where
 * meaningful" clause of requirements section 9.2 item 12 — a pager with two
 * dead ends is chrome describing nothing.
 */
export function collectionNeighbours(
  entry: ContentEntry,
  entries: readonly ContentEntry[],
): CollectionNeighbours {
  if (entry.collection === undefined) return {};
  const facet = collectionFacets(entries).find((candidate) => candidate.key === entry.collection);
  if (facet === undefined) return {};

  const at = facet.entries.findIndex((member) => member.slug === entry.slug);
  if (at < 0) return {};
  return {
    previous: at > 0 ? facet.entries[at - 1] : undefined,
    next: at + 1 < facet.entries.length ? facet.entries[at + 1] : undefined,
  };
}
