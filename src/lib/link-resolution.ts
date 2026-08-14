/**
 * One resolver for every link a note can write, and one typed outcome per link.
 *
 * Five spellings reach this module — a bare wikilink, a vault-root wikilink, a
 * relative wikilink, a standard Markdown link, and a wikilink carrying display
 * text — and there is exactly one function under them. Obsidian itself works
 * this way: its internal/external test (`WE`) routes a Markdown href through
 * `decodeURI` and then hands it to the *same* `getLinkpathDest` a wikilink gets.
 * Building a second resolver is how two answers drift apart, and the drift is
 * invisible until a reader clicks something.
 *
 * ## The order is reverse-engineered, not documented, and this is its shape
 *
 * `.tmp/ssg-research.md` recovered it by unpacking `obsidian.asar` and executing
 * the shipped `MetadataCache.prototype.getLinkpathDest` against synthetic
 * vaults. Obsidian is closed source and both the help site and the public API
 * reference decline to state precedence — the reference says only "Get the best
 * match for a linkpath." So the tiers below are transcribed from that recovery,
 * and the gates that hold them source their expected values from a *separate*
 * transcription of the same function rather than from this file.
 *
 * `getFirstLinkpathDest` is `getLinkpathDest(...)[0] ?? null`, and
 * `uniqueFileLookup` is a multimap keyed by lowercase filename **with**
 * extension. From there:
 *
 * - **Tier 0, the candidate set.** If the linkpath's basename contains a `.`,
 *   probe it as written; if that misses, or there was no dot, append `.md` and
 *   probe again. No basename match ends resolution — there is no alias, title,
 *   or permalink fallback. This is what makes `[[Figure 1]]` against a real
 *   `Figure 1.png` resolve to nothing, which is documented behaviour: a
 *   non-Markdown target must carry its extension.
 * - **Tier 1.** A bare name with exactly one candidate. The only tier requiring
 *   uniqueness, so *any* collision skips it — which is why a collision does not
 *   simply pick the near one here.
 * - **Tier 2.** An explicit `./` or `../` joined onto the source's directory,
 *   exact full-path match. On failure it does **not** return; it falls through
 *   to the later tiers carrying the rewritten path.
 * - **Tier 3.** Exact corpus-root path, with a leading `/` stripped first. This
 *   is why a root-level `items.md` is **not** shadowed by `archive/items.md`:
 *   tier 1 was skipped by the collision, and the bare name happens to *be* a
 *   root path.
 * - **Tier 4.** Tier 3 missed and the link was *written* with a leading `/` —
 *   resolution ends. A leading slash is a strict root anchor, not a dead end;
 *   widely-copied third-party notes claim such a link never resolves at all, and
 *   the research executed it and found the slash is stripped before tier 3.
 * - **Tier 5.** Suffix match over candidate paths, bucketed by proximity to the
 *   source, shortest first.
 *
 * ## Where this deliberately differs, and why each difference is not a taste
 *
 * **Tier 5's matching is hardened to be segment-aware.** Obsidian's own test is
 * a raw-string `endsWith`/`startsWith`, and executed, `[[ary/index]]` resolves
 * to `knowledge/glossary/index.md` while a source in `proj/` prefers
 * `projects/note.md` over `zzz/note.md`. Those are defects rather than
 * semantics: nobody writes `ary/index` meaning that file. Tier 5 cannot simply
 * be deleted, because Obsidian's own `relative` link format emits prefix-less
 * multi-segment paths (`[[b/note]]`) that reach nothing else.
 *
 * **Tier 5's ranking is made total.** Obsidian sorts by path length and lets
 * equal lengths fall to `uniqueFileLookup` insertion order, which is filesystem
 * scan order — executed, reversing the input order reverses the winner. A build
 * promising byte-identical output cannot rank on that, so the tiebreak here is
 * (length, then the path itself), which depends on nothing but the two paths.
 *
 * **Ambiguity is an outcome, not a build failure.** It warns: the link is
 * resolved by the order above, it renders, and every candidate is recorded.
 * Failing was considered and rejected as unbounded and unoverridable — it is
 * worst exactly where it is most likely, two notes sharing a basename, and a
 * stranger running this tool on their own repository cannot always act on it.
 * Silent resolution was rejected just as firmly: that is the defect this
 * resolver exists to beat, where zero matches and five matches fall through
 * identically.
 *
 * **Aliases are not link targets.** Obsidian desktop's `getLinkpathDest` reads
 * `uniqueFileLookup` and nothing else, and a detailed bug report asking for
 * alias resolution was closed as intentional. Obsidian *Publish* disagrees — its
 * resolver has an alias tier and a permalink map, and the differential was
 * executed: `[[alias-name]]` is `null` on desktop and `Real.md` on Publish.
 * "Obsidian-compatible" is therefore ambiguous, and this module names which
 * implementation it reproduces.
 *
 * **Unicode is NFC-normalised on both sides.** Obsidian normalises the link text
 * only; filenames come from the OS unnormalised, so an NFC link against an NFD
 * filename resolves to nothing. Normalising both makes the answer identical on
 * every runner, which a build needs and an editor does not.
 *
 * ## Case, and why it is the one place `markdown-to-artifact.ts` does not apply
 *
 * Discovery compares names byte-exactly and never calls `globSync`, because that
 * call answers differently per platform and can return a name that is not on
 * disk. That rule decides **which files exist**, and nothing here weakens it:
 * this module never touches the filesystem and is handed the paths the walk
 * already found.
 *
 * Resolution is a different question — *which of those files did the author
 * mean* — and there the researched answer is unambiguous: keys are
 * `file.name.toLowerCase()`, the linkpath is lowercased, and every `===`,
 * `endsWith`, and `startsWith` runs on lowercased strings. Executed,
 * `[[projects/THREE laws]]` resolves to `Projects/Three Laws.md`. A byte-exact
 * resolver answers nothing there, and hand-written links disagreeing in case
 * with the filename are ordinary in a real vault.
 *
 * The hazard case-insensitivity carries is that `Note.md` and `note.md` share
 * one key, so on a case-sensitive filesystem tier 3's exact test matches *both*
 * and Obsidian returns whichever the scan saw first. Here that pair is simply
 * ambiguity — reported, with both candidates named — and the winner comes from
 * the total tiebreak rather than from scan order.
 */

import Slugger from 'github-slugger';

/**
 * One file the corpus contains, and the route it publishes to if it does.
 *
 * Resolution runs over the **full** file set and publication is tested
 * afterwards, which is the whole reason `slug` is optional rather than this
 * taking a list of published notes. Resolving against the published set only
 * would merge two different events with two different fixes: a link to a note
 * the user excluded, and a link to nothing at all. The first is a
 * publication-boundary event — the mistyped-exclusion hazard seen from the other
 * side — and it is the most useful line the report carries.
 */
export interface CorpusFile {
  /** Path relative to the content root, in POSIX separators. */
  readonly path: string;
  /** The published slug, or absent for a file this build did not publish. */
  readonly slug?: string | undefined;
}

/**
 * What one link turned out to name. A closed set, because a free-text outcome
 * cannot be gated on and cannot be switched on.
 *
 * The members discriminate on **what a producer must do with the node**, which
 * is the only question the two consumers — the traversal that rewrites the
 * Markdown, and the report — actually ask.
 *
 * `candidates` appears on exactly the two members where more than one candidate
 * is possible. Its absence from `resolved` is an invariant rather than an
 * omission: `resolved` means the tiers narrowed to one file.
 */
export type LinkResolution =
  /**
   * Not a link into this corpus. An absolute URL, any scheme, or a fragment
   * into the page being rendered. `node.url` is left exactly as written and no
   * edge is recorded — including for the same-page fragment, which is a real
   * link but never an edge, since an entry may not link to itself.
   */
  | { readonly kind: 'external' }
  /** Exactly one candidate, and this build published it. */
  | {
      readonly kind: 'resolved';
      readonly path: string;
      readonly slug: string;
      /** `#id` for a subpath, or `''`. See {@link anchorFor}. */
      readonly anchor: string;
    }
  /**
   * Several candidates. The winner is published and the link renders; every
   * candidate is named so the author can disambiguate.
   */
  | {
      readonly kind: 'ambiguous';
      readonly path: string;
      readonly slug: string;
      readonly anchor: string;
      /** Every candidate the tiers considered, sorted. Length ≥ 2. */
      readonly candidates: readonly string[];
    }
  /**
   * The winner is a file this build did not publish — an excluded note, or an
   * image, or any other non-note. The link is replaced by its display text and
   * the target path never enters the artifact.
   */
  | {
      readonly kind: 'unpublished';
      readonly path: string;
      /** Every candidate the tiers considered, sorted. Length ≥ 1. */
      readonly candidates: readonly string[];
    }
  /** No candidate at all. The link is replaced by its display text. */
  | { readonly kind: 'unresolved' };

/**
 * The corpus, keyed the way the researched algorithm keys it.
 *
 * Built once per build rather than per link: tier 0 is a map lookup and every
 * later tier filters the small list that lookup returned, so the cost of a link
 * is the size of its own basename collision rather than the size of the corpus.
 */
export interface LinkIndex {
  /** Lowercase NFC filename *with* extension, to every candidate carrying it. */
  readonly byName: ReadonlyMap<string, readonly Candidate[]>;
}

/**
 * One file as the tiers see it: what to report, and what to compare against.
 *
 * The two are separate because they answer different questions. `file.path` is
 * the name on disk, which is what a report must print and what a slug was
 * derived from; `comparable` is that path NFC-normalised, which is what every
 * tier matches on. Storing the normalised form rather than normalising at each
 * comparison also keeps the work out of the inner loop.
 */
interface Candidate {
  readonly file: CorpusFile;
  /** {@link CorpusFile.path}, NFC-normalised. Never printed. */
  readonly comparable: string;
}

/** POSIX basename, on the `/`-joined relative paths the walk produces. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** POSIX dirname; `''` for a path at the corpus root, as Obsidian's `Pl` gives. */
function dirname(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

/**
 * NFC, matching what `obsidian-export` does to both sides and what Obsidian does
 * to only one.
 *
 * The divergence is deliberate and named in this module's header: a filename
 * arrives from the OS in whatever form that OS stores, macOS hands back
 * decomposed forms, and a link normalised against a filename that is not
 * normalised resolves to nothing on one machine and correctly on another.
 */
function normalise(text: string): string {
  return text.normalize('NFC');
}

/** Build the index a whole build resolves against. */
export function indexCorpus(files: readonly CorpusFile[]): LinkIndex {
  const byName = new Map<string, Candidate[]>();
  for (const file of files) {
    // **The whole path is normalised, not only the key.** Normalising the
    // basename alone was measured to leave the divergence intact for every
    // multi-segment form: with `nfd/café.md` on disk in decomposed form,
    // `[[café]]` resolved through the key and `[[nfd/café]]` written in NFC did
    // not, because tiers 2, 3, and 5 compare `file.path` against a normalised
    // linkpath. `path` keeps its authored form for the report and the artifact;
    // `comparable` is what the tiers read.
    const comparable = normalise(file.path);
    const key = basename(comparable).toLowerCase();
    const entry = { file, comparable };
    const bucket = byName.get(key);
    if (bucket === undefined) byName.set(key, [entry]);
    else bucket.push(entry);
  }
  return { byName };
}

/**
 * A link's path half and its subpath, split at the **first** `#`.
 *
 * First rather than last, and this is Obsidian's `parseLinktext`: `note#a#b` is
 * the path `note` with the subpath `#a#b`, which is a nested-heading reference
 * rather than a file called `note#a`. A leading `#` gives an empty path, which
 * is a reference into the page the link was written on.
 */
function splitLinktext(link: string): { path: string; subpath: string } {
  const hash = link.indexOf('#');
  return hash === -1
    ? { path: link, subpath: '' }
    : { path: link.slice(0, hash), subpath: link.slice(hash) };
}

/**
 * The `#id` this site can actually serve for a subpath, or `''`.
 *
 * **A deliberate approximation, and the direction of its error is the reason it
 * is acceptable.** Obsidian matches a subpath against the target's own headings
 * with a comparator that is not a slugger — it strips a fixed punctuation class,
 * collapses whitespace, trims, and lowercases, leaving `-`, `_`, and `'` to
 * match literally. Reproducing that needs every target's heading list at
 * resolution time, and then a second mapping from the matched heading to the id
 * `src/lib/markdown.ts` mints — which is a second model of heading identity, and
 * the first place the two would silently disagree is the place nobody looks.
 *
 * What is done instead is to run the subpath through the *same* slugger the
 * renderer uses. That agrees exactly whenever the author wrote the heading's
 * text verbatim, which is what Obsidian's own autocomplete inserts. It
 * disagrees only when the author wrote something Obsidian's comparator forgives
 * and the slugger does not — and there the link lands at the top of the right
 * page rather than at a wrong one. Never a wrong page, and never a dangling
 * anchor.
 *
 * A block reference (`#^id`) gets no anchor at all: this site emits no block
 * anchors, so any id minted for one would point at nothing. Obsidian's own docs
 * warn that block references do not work outside Obsidian.
 *
 * A nested reference (`#a#b`) uses the last part, which is the heading actually
 * being pointed at; the intermediate parts only constrain depth.
 *
 * A fresh slugger per call, deliberately: `github-slugger` deduplicates across
 * a document, and this is not walking one. The undeduplicated form is the id a
 * heading gets on its first occurrence, which is the one a reader links to.
 */
function anchorFor(subpath: string): string {
  const parts = subpath.split('#').filter((part) => part !== '');
  const last = parts.at(-1);
  if (last === undefined || last.startsWith('^')) return '';
  const id = new Slugger().slug(last);
  return id === '' ? '' : `#${id}`;
}

/**
 * Segment-aware suffix match, replacing tier 5's raw-string `endsWith`.
 *
 * `'knowledge/glossary/index.md'.endsWith('ary/index.md')` is true, and that is
 * the executed defect: `[[ary/index]]` resolves to a file nobody named.
 */
function matchesSuffix(path: string, link: string): boolean {
  return path === link || path.endsWith(`/${link}`);
}

/**
 * Segment-aware containment, replacing tier 5's raw-string `startsWith`.
 *
 * `'projects/note.md'.startsWith('proj')` is true, so a source in `proj/`
 * executed as preferring `projects/note.md` over `zzz/note.md`. A corpus-root
 * source has `dirname === ''`, under which every candidate is "near" — that is
 * Obsidian's behaviour too, and it is why the bucket split is inert for
 * root-level notes rather than being a special case here.
 */
function inSourceSubtree(path: string, directory: string): boolean {
  return directory === '' || path === directory || path.startsWith(`${directory}/`);
}

/**
 * Join a `./` or `../` link onto the source's directory.
 *
 * Written out rather than delegated to `path.posix.join`, for one reason worth
 * the eight lines: `join` is separator-aware in a way that differs by platform
 * on win32 for the *other* `path` namespace, and every path here is already a
 * `/`-joined relative path the walk produced. A `..` that would climb above the
 * corpus root is dropped, which is the only definition that keeps the result a
 * corpus-relative path.
 */
function joinRelative(directory: string, link: string): string {
  const parts = directory === '' ? [] : directory.split('/');
  for (const segment of link.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

/** Total, and depending on nothing but the two paths. See the header. */
function rank(a: Candidate, b: Candidate): number {
  const left = a.file.path;
  const right = b.file.path;
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Whether a link points out of the corpus, by Obsidian's own test (`WE`).
 *
 * `startsWith('./') || startsWith('../') || indexOf(':') === -1`. The colon test
 * is what makes `https://example.com` and `mailto:x` external while
 * `notes/a.md` is not, and the two explicit relative prefixes are what keep
 * `./a:b` internal despite carrying one.
 */
function isExternal(href: string): boolean {
  if (href.startsWith('./') || href.startsWith('../')) return false;
  return href.includes(':');
}

/**
 * Percent-decoding for a Markdown href, and `decodeURI` rather than
 * `decodeURIComponent`.
 *
 * The difference is load-bearing rather than incidental: `decodeURI` decodes
 * `%20` and leaves `%23` encoded, so a filename containing a literal `#` stays
 * distinguishable from the subpath separator. `decodeURIComponent` would decode
 * both and turn one into the other.
 *
 * A malformed sequence throws, and the honest answer is the href as written: a
 * link nobody can decode is a link that resolves to nothing, and it will be
 * reported as such rather than crashing the build over a typo.
 */
function decodeHref(href: string): string {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}

/**
 * Resolve one link written in one file.
 *
 * @param link The link exactly as authored — a wikilink's target, or a Markdown
 *   href. Both reach the same tiers; the href is percent-decoded first, which is
 *   the only difference between the two syntaxes anywhere in this module.
 * @param sourcePath The writing file's path, relative to the corpus root. Tiers
 *   2 and 5 are the only ones that read it.
 * @param index Built once per build by {@link indexCorpus}.
 * @param isWikilink Wikilinks are not percent-encoded, so they are not decoded.
 */
export function resolveLink(
  link: string,
  sourcePath: string,
  index: LinkIndex,
  isWikilink: boolean,
): LinkResolution {
  const written = isWikilink ? link.trim() : decodeHref(link.trim());

  // A bare fragment is a reference into the page being written, which is a real
  // link and never an edge. Tested before the external check, which would
  // otherwise call it internal and send an empty path into the tiers.
  if (written === '' || written.startsWith('#')) return { kind: 'external' };
  if (isExternal(written)) return { kind: 'external' };

  const { path: linkPath, subpath } = splitLinktext(written);
  if (linkPath === '') return { kind: 'external' };

  const anchor = anchorFor(subpath);
  const candidates = candidatesFor(normalise(linkPath), normalise(sourcePath), index);

  if (candidates.length === 0) return { kind: 'unresolved' };

  const sorted = [...candidates].sort(rank);
  const winner = sorted[0]!.file;
  const names = sorted.map((candidate) => candidate.file.path).sort();

  if (winner.slug === undefined) return { kind: 'unpublished', path: winner.path, candidates: names };
  if (sorted.length > 1) {
    return { kind: 'ambiguous', path: winner.path, slug: winner.slug, anchor, candidates: names };
  }
  return { kind: 'resolved', path: winner.path, slug: winner.slug, anchor };
}

/**
 * The tiers, in order, returning every file the winning tier admits.
 *
 * Returning a *set* rather than a winner is what makes ambiguity expressible:
 * the researched function returns an array and its caller takes `[0]`, which is
 * precisely where the information that there were five is thrown away.
 *
 * Each tier that fires returns; tier 2 is the documented exception and falls
 * through with the path it rewrote.
 */
function candidatesFor(linkPath: string, sourcePath: string, index: LinkIndex): readonly Candidate[] {
  // Tier 0. The extension probe, in the researched order: as written when the
  // basename carries a dot, then with `.md` appended. Two probes rather than
  // parsing, which is why `[[Note.1]]` finds `Note.1.md` and why an
  // extensionless file literally named `Node.js` beats `Node.js.md`.
  let name = linkPath.toLowerCase();
  let key = basename(name);
  let found = key.includes('.') ? index.byName.get(key) : undefined;
  if (found === undefined) {
    name = `${linkPath}.md`.toLowerCase();
    key = basename(name);
    found = index.byName.get(key);
  }
  if (found === undefined || found.length === 0) return [];

  // Tier 1. A bare name — the probe did not change the path shape — with
  // exactly one candidate. The only tier requiring uniqueness, so a collision
  // falls to the tiers below rather than picking here.
  if (key === name && found.length === 1) return found;

  const sourceDirectory = dirname(sourcePath).toLowerCase();

  // Tier 2. Explicit `./` or `../`, joined onto the source's directory and
  // matched exactly. It does not return on failure: the rewritten path carries
  // into tiers 3 and 5, which is how `[[../x]]` from a nested file can still
  // find a suffix match.
  if (name.startsWith('./') || name.startsWith('../')) {
    name = joinRelative(sourceDirectory, name);
    const exact = found.filter((candidate) => candidate.comparable.toLowerCase() === name);
    if (exact.length > 0) return exact;
  }

  const anchored = name.startsWith('/');
  if (anchored) name = name.slice(1);

  // Tier 3. Exact corpus-root path. Every candidate matching is returned rather
  // than the first, which is the case-only collision: `Note.md` and `note.md`
  // both lowercase to one string and Obsidian hands back whichever the scan saw
  // first.
  const exact = found.filter((candidate) => candidate.comparable.toLowerCase() === name);
  if (exact.length > 0) return exact;

  // Tier 4. A link written with a leading `/` is a strict root anchor: it asked
  // for one exact path and did not get it, so it declines the fuzzy fallback
  // rather than guessing.
  if (anchored) return [];

  // Tier 5, with both string tests made segment-aware. See the header for the
  // two executed defects that decides.
  const survivors = found.filter((candidate) => matchesSuffix(candidate.comparable.toLowerCase(), name));
  const near = survivors.filter((candidate) =>
    inSourceSubtree(candidate.comparable.toLowerCase(), sourceDirectory),
  );
  return near.length > 0 ? near : survivors;
}
