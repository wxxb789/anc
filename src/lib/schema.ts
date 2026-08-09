/**
 * Authoritative schema for the generated public content artifact.
 *
 * The artifact is produced by the reviewed exporter in the private vault and is
 * never hand-edited here. Validation is deliberately strict: unknown fields are
 * rejected so that a future exporter change is a loud build failure rather than
 * a silent privacy leak.
 */

export interface ContentEntry {
  slug: string;
  title: string;
  excerpt: string;
  markdown: string;
  outgoing: string[];
  backlinks: string[];
  public_id?: string;
  created?: string;
  updated?: string;
  language?: string;
  tags?: string[];
  collection?: string;
  status?: 'published' | 'tombstone';
  aliases?: string[];
  description?: string;
}

export interface ContentArtifact {
  version: 1;
  entries: ContentEntry[];
}

export const SCHEMA_VERSION = 1;

/** Top-level route segments the site owns; a note slug may not collide with them. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'notes',
  'tags',
  'collections',
  'recent',
  'graph',
  'search',
  'about',
  'privacy',
  '404',
  'rss',
  'sitemap',
  'pagefind',
  'data',
  'wasm',
]);

/**
 * Lowercase `[a-z0-9-]`, no leading, trailing, or doubled hyphen.
 *
 * The doubled-hyphen rule exists because a slug and a collection are used
 * *verbatim* as public route segments, and `src/lib/routes.ts` rejects a
 * doubled separator in any route key — a tag of `Ops & SRE` slugs to `ops--sre`
 * and is collapsed to `ops-sre` before it is addressable. Admitting `a--b` here
 * while routing refuses it would let a schema-valid artifact fail the build at
 * a later stage, which is the one failure mode this contract exists to prevent.
 * The two rules are asserted to agree in `tests/route-model.test.ts`.
 */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** ISO 8601 calendar date, optionally with a time and explicit offset. */
const DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;
/** BCP 47 shape, e.g. `en`, `zh-CN`, `zh-Hans-CN`. */
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** Joins emoji sequences into one glyph, so it is allowed inside a tag or alias. */
const ZERO_WIDTH_JOINER = String.fromCharCode(0x200d);

const STATUS_VALUES: ReadonlySet<string> = new Set(['published', 'tombstone']);

const REQUIRED_STRINGS = ['slug', 'title', 'excerpt', 'markdown'] as const;
const REQUIRED_ARRAYS = ['outgoing', 'backlinks'] as const;
const OPTIONAL_FIELDS = [
  'public_id',
  'created',
  'updated',
  'language',
  'tags',
  'collection',
  'status',
  'aliases',
  'description',
] as const;

const KNOWN_FIELDS: ReadonlySet<string> = new Set<string>([
  ...REQUIRED_STRINGS,
  ...REQUIRED_ARRAYS,
  ...OPTIONAL_FIELDS,
]);

/**
 * Size ceilings, stated per field.
 *
 * Without these the contract bounds nothing: a 3 MB `markdown` body and 5,000
 * tags both pass, and 5,000 tags on one entry is 5,000 public routes. A limit
 * that fails validation is a message naming the field; the same input without
 * one is a build that either takes minutes or emits a route map the host
 * rejects.
 *
 * Lengths are counted in UTF-16 code units, which is what `String.length`
 * returns. The number is a size ceiling, not a grapheme count, so counting
 * astral characters as two is the honest direction: an emoji really does cost
 * twice a Latin letter to store and to serve.
 *
 * Each ceiling is set an order of magnitude above anything the corpus plausibly
 * produces, so it catches a runaway exporter rather than constraining an author.
 */
const STRING_LIMITS: Partial<Record<keyof ContentEntry, number>> = {
  // A path segment, and part of every redirect rule; Cloudflare caps a rule
  // line at 1,000 characters and a rule carries the slug twice.
  slug: 128,
  // A `<title>`, a card heading, and a search result. Search engines truncate a
  // title well below this.
  title: 300,
  // The `<meta name="description">`, the card body, and the hover preview.
  excerpt: 1000,
  description: 1000,
  // Requirements section 18 warns above 250 KB of uncompressed article HTML,
  // and rendering Markdown only adds markup, so the source is bounded below it.
  markdown: 200_000,
  // An opaque public identifier, not prose.
  public_id: 128,
  // BCP 47 language tags are capped at 35 characters by the registry itself.
  language: 35,
  collection: 128,
};

/** Array ceilings: how many members, and how long each member may be. */
const ARRAY_LIMITS: Partial<Record<keyof ContentEntry, { items: number; itemChars?: number }>> = {
  // Every tag is a public route, so an unbounded tag list is an unbounded page
  // count. A note carrying more than this is a classification failure, not a
  // note. (The redirect ceiling is a separate limit on the *corpus*; see
  // `MAX_ENTRIES`.)
  tags: { items: 50, itemChars: 128 },
  // Every alias is a link-resolution key.
  aliases: { items: 50, itemChars: 300 },
  // Each member must already resolve to a published slug, so member length is
  // bounded transitively by the slug ceiling; only the count needs one.
  outgoing: { items: 500 },
  backlinks: { items: 500 },
};

/** Size ceilings for a field, exposed so a consumer can state the same number. */
export const FIELD_LIMITS = { strings: STRING_LIMITS, arrays: ARRAY_LIMITS } as const;

/**
 * How many entries one artifact may carry.
 *
 * The binding constraint is per-entry build cost, not any one page: a corpus
 * this large means 900 rendered note pages, 900 Pagefind records, and a page
 * per facet on top. An artifact past this is an exporter fault — the allowlist
 * is hand-curated — and saying so here means it is caught before anything is
 * generated, with a message naming the artifact.
 *
 * 900 rather than a round 1,000 to leave headroom under Cloudflare Pages'
 * ceiling of 2,000 static redirect rules. TK-11 set it when every entry emitted
 * two rules; TK-12 deleted those rules, so today the ceiling is not binding and
 * `REDIRECT_RULES` is a hand-written literal that cannot grow with the corpus.
 * The number is kept because it stays correct if a later rename ever strands a
 * URL and rules become derived again — at two per entry this corpus is still
 * inside the host's limit.
 */
export const MAX_ENTRIES = 900;

function checkLimits(value: Record<string, unknown>, label: string, issues: string[]): void {
  for (const [field, max] of Object.entries(STRING_LIMITS)) {
    const item = value[field];
    if (typeof item === 'string' && item.length > max) {
      issues.push(`${label}.${field}: is ${item.length} characters, over the ${max} character limit`);
    }
  }

  for (const [field, { items, itemChars }] of Object.entries(ARRAY_LIMITS)) {
    const list = value[field];
    if (!Array.isArray(list)) continue;
    if (list.length > items) {
      issues.push(`${label}.${field}: has ${list.length} entries, over the limit of ${items}`);
    }
    if (itemChars === undefined) continue;
    for (const [position, member] of list.entries()) {
      if (typeof member === 'string' && member.length > itemChars) {
        issues.push(
          `${label}.${field}[${position}]: is ${member.length} characters, ` +
            `over the ${itemChars} character limit`,
        );
      }
    }
  }
}

type Rule = readonly [RegExp, string];

/**
 * Markers that must never reach a public artifact. Scanned against each entry's
 * string values so that no field, present or future, can smuggle one through.
 *
 * These are deliberately NOT matched against a whitespace-stripped form: doing so
 * would join unrelated lines and turn prose such as "Option A:" above "/usr/bin"
 * into an apparent drive path.
 */
const STRUCTURAL_MARKERS: readonly Rule[] = [
  [/msw\//i, 'private "msw/" path marker'],
  [/\[\[/, 'unresolved [[wikilink]]'],
  [/(?<![A-Za-z])[A-Za-z]:[\\/]/, 'absolute local path'],
];

/**
 * Schemes a browser resolves after discarding whitespace anywhere in the URL, so
 * these are matched against a whitespace-stripped form too. Mirrors the
 * exporter's own rule. `file:` carries a lookbehind so that ordinary words
 * ending in "file" ("profile:", "makefile:") followed by "//" stay readable.
 */
const UNSAFE_SCHEMES: readonly Rule[] = [
  [/javascript:/i, 'javascript: URL'],
  [/vbscript:/i, 'vbscript: URL'],
  [/(?<![A-Za-z])file:\/\//i, 'file:// URL'],
];

/**
 * A `data:` URL whose media type is not an allowlisted base64 raster image.
 *
 * Anchored on the `,` that separates a data URL's media type from its payload,
 * so prose such as "Response data: see below" is not mistaken for one. The media
 * type is optional because `data:,` and `data:;base64,` are both legal and both
 * default to `text/plain`, and it is matched as "anything up to the comma" so a
 * parameter or a wildcard type cannot carry a payload past the gate.
 *
 * Interior whitespace is excluded: a media type containing a space does not
 * parse, so `data:text /html,x` degrades to `text/plain` in a browser, and
 * excluding it is what keeps a sentence like "Sample data: see docs/guide, then
 * run it" readable. Whitespace immediately after `data:` or before the comma IS
 * stripped by the browser, so `stripDataUrlPadding` removes it before this runs.
 */
const DISALLOWED_DATA_URI: Rule = [
  /data:(?!image\/(?:png|jpe?g|gif|webp|avif);base64,)(?:,|[^,\s]*(?:\/|;base64)[^,\s]*,)/i,
  'non-image data: URL',
];

/**
 * Drop the whitespace a browser trims from a data URL's media type (fetch spec:
 * the media type is trimmed before parsing), so `data: text/html,` and
 * `data:text/html ,` are judged as the `text/html` they actually resolve to.
 */
function stripDataUrlPadding(text: string): string {
  return text.replace(/(data:)[ \t]+/gi, '$1').replace(/[ \t]+,/g, ',');
}

/**
 * Characters a URL parser discards from anywhere in a URL (WHATWG URL: tab, LF,
 * CR) plus the invisible format characters that could hide inside a marker. A
 * literal space is deliberately NOT removed — browsers do not strip it, so
 * removing it here would fuse ordinary prose into an apparent URL.
 */
const URL_IGNORED = /[\t\n\r\p{Cf}]+/gu;

/** Invisible characters only: safe to remove before looking for a literal marker. */
const INVISIBLE = /\p{Cf}+/gu;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  colon: ':',
  gt: '>',
  lt: '<',
  newline: '\n',
  quot: '"',
  sol: '/',
  tab: '\t',
};

export class ContentValidationError extends Error {
  readonly issues: readonly string[];

  constructor(source: string, issues: readonly string[]) {
    super(
      `${source}: ${issues.length} content contract violation${issues.length === 1 ? '' : 's'}\n` +
        issues.map((issue) => `  - ${issue}`).join('\n'),
    );
    this.name = 'ContentValidationError';
    this.issues = issues;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Decode the entity forms a browser would resolve inside an attribute value. */
function decodeEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));?/g,
    (match, decimal?: string, hex?: string, name?: string) => {
      const code = decimal !== undefined ? Number(decimal) : hex !== undefined ? parseInt(hex, 16) : NaN;
      if (Number.isFinite(code)) return code <= 0x10ffff ? String.fromCodePoint(code) : match;
      return (name !== undefined ? NAMED_ENTITIES[name.toLowerCase()] : undefined) ?? match;
    },
  );
}

function scan(text: string, rules: readonly Rule[], found: Set<string>): void {
  for (const [pattern, label] of rules) if (pattern.test(text)) found.add(label);
}

/**
 * Every string reachable in the entry, so no field can hide a marker in a nested
 * value. Iterative rather than recursive, and pushing one element at a time
 * rather than spreading: a deeply nested or very wide artifact must fail
 * validation with a contract error, not crash the build.
 */
function* strings(value: unknown): Generator<string> {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === 'string') yield current;
    else if (Array.isArray(current)) for (const item of current) stack.push(item);
    else if (typeof current === 'object' && current !== null) {
      for (const [key, item] of Object.entries(current)) {
        yield key;
        stack.push(item);
      }
    }
  }
}

function checkPrivacy(entry: Record<string, unknown>, label: string, issues: string[]): void {
  const found = new Set<string>();

  // Scan the parsed string values, not the JSON encoding of the entry: in JSON
  // text a newline is the two characters "\" + "n", which would make ordinary
  // prose such as "Option A:\n- foo" look like the drive path "A:\".
  for (const value of strings(entry)) {
    const decoded = decodeEntities(value);
    // Structural markers get the invisible characters removed, so `msw<ZWJ>/x`
    // cannot hide a private path that a browser would still render as `msw/x`.
    // They do NOT get line breaks removed: joining lines would turn prose such
    // as "Option A:" above "/usr/bin" into an apparent drive path.
    const visible = decoded.replace(INVISIBLE, '');
    // Scheme rules additionally drop the tab/CR/LF a URL parser ignores, so
    // `java\tscript:` inside one URL is caught. This mirrors the exporter.
    const compact = decoded.replace(URL_IGNORED, '');
    for (const text of [value, decoded, visible]) scan(text, STRUCTURAL_MARKERS, found);
    for (const text of [value, decoded, compact]) {
      scan(text, UNSAFE_SCHEMES, found);
      scan(stripDataUrlPadding(text), [DISALLOWED_DATA_URI], found);
    }
  }

  for (const marker of [...found].sort()) issues.push(`${label}: forbidden ${marker} in serialized entry`);
}

function checkStringArray(
  value: unknown,
  label: string,
  issues: string[],
  options: { sorted: boolean },
): value is string[] {
  if (!Array.isArray(value)) {
    issues.push(`${label}: must be an array of strings`);
    return false;
  }
  const clean = value.filter((item, index) => {
    const ok = typeof item === 'string' && item.trim() !== '' && item === item.trim();
    if (!ok) issues.push(`${label}[${index}]: must be a non-empty string without surrounding whitespace`);
    return ok;
  }) as string[];
  if (clean.length !== value.length) return false;

  if (new Set(clean).size !== clean.length) issues.push(`${label}: must not contain duplicates`);
  if (options.sorted && clean.some((item, index) => index > 0 && clean[index - 1]! > item)) {
    issues.push(`${label}: must be sorted in ascending order`);
  }
  return true;
}

function checkEntry(value: unknown, index: number, issues: string[]): ContentEntry | undefined {
  if (!isPlainObject(value)) {
    issues.push(`entries[${index}]: must be an object`);
    return undefined;
  }

  const slug = value['slug'];
  const label = typeof slug === 'string' ? `entries[${index}] (slug "${slug}")` : `entries[${index}]`;
  const before = issues.length;

  for (const field of Object.keys(value)) {
    if (!KNOWN_FIELDS.has(field)) issues.push(`${label}.${field}: unknown field is not allowed`);
  }

  for (const field of REQUIRED_STRINGS) {
    const item = value[field];
    if (typeof item !== 'string') issues.push(`${label}.${field}: is required and must be a string`);
    else if (field !== 'excerpt' && item.trim() === '') issues.push(`${label}.${field}: must not be empty`);
  }

  if (typeof slug === 'string') {
    if (!SLUG.test(slug)) {
      issues.push(`${label}.slug: must be lowercase [a-z0-9-] without a leading or trailing hyphen`);
    } else if (RESERVED_SLUGS.has(slug)) {
      issues.push(`${label}.slug: collides with reserved route segment "${slug}"`);
    }
  }

  for (const field of REQUIRED_ARRAYS) {
    if (!(field in value)) issues.push(`${label}.${field}: is required`);
    else checkStringArray(value[field], `${label}.${field}`, issues, { sorted: true });
  }

  for (const field of ['public_id', 'collection', 'description'] as const) {
    const item = value[field];
    if (item !== undefined && (typeof item !== 'string' || item.trim() === '')) {
      issues.push(`${label}.${field}: must be a non-empty string when present`);
    }
  }
  if (typeof value['collection'] === 'string' && !SLUG.test(value['collection'])) {
    issues.push(`${label}.collection: must be lowercase [a-z0-9-] without a leading or trailing hyphen`);
  }

  for (const field of ['created', 'updated'] as const) {
    const item = value[field];
    if (item !== undefined && (typeof item !== 'string' || !DATE.test(item) || Number.isNaN(Date.parse(item)))) {
      issues.push(`${label}.${field}: must be an ISO 8601 date when present`);
    }
  }

  const language = value['language'];
  if (language !== undefined && (typeof language !== 'string' || !LANGUAGE.test(language))) {
    issues.push(`${label}.language: must be a BCP 47 language tag when present`);
  }

  const status = value['status'];
  if (status !== undefined && (typeof status !== 'string' || !STATUS_VALUES.has(status))) {
    issues.push(`${label}.status: must be one of ${[...STATUS_VALUES].join(', ')} when present`);
  }

  // Tags become `/tags/<tag>/` route keys and aliases become link-resolution keys.
  // A "/" would break routing and could carry a private path fragment; a control
  // or format character (bidi overrides, soft hyphens) could disguise either.
  // U+200D is exempt: it joins emoji sequences such as a person-at-keyboard glyph.
  for (const field of ['tags', 'aliases'] as const) {
    const item = value[field];
    if (item === undefined) continue;
    if (checkStringArray(item, `${label}.${field}`, issues, { sorted: false })) {
      for (const [position, member] of item.entries()) {
        if (member.includes('/') || /[\p{Cc}\p{Cf}]/u.test(member.replaceAll(ZERO_WIDTH_JOINER, ''))) {
          issues.push(`${label}.${field}[${position}]: must not contain "/" or a control character`);
        }
      }
    }
  }

  // Size before content, and an oversized entry stops here: a 3 MB body is
  // rejected on its length rather than scanned four times over first, which is
  // what makes "a contract error, not a slow build" true rather than
  // aspirational. Only a *size* issue short-circuits — an entry with an unknown
  // field or a bad slug is still privacy-scanned, so no violation goes
  // unreported for an entry that would otherwise have been merely malformed.
  const beforeLimits = issues.length;
  checkLimits(value, label, issues);
  if (issues.length !== beforeLimits) return undefined;

  checkPrivacy(value, label, issues);

  return issues.length === before ? (value as unknown as ContentEntry) : undefined;
}

function checkCorpus(entries: readonly ContentEntry[], issues: string[]): void {
  const bySlug = new Map<string, ContentEntry>();
  for (const entry of entries) {
    if (bySlug.has(entry.slug)) issues.push(`entries: duplicate slug "${entry.slug}"`);
    else bySlug.set(entry.slug, entry);
  }

  const aliasOwner = new Map<string, string>();
  for (const entry of entries) {
    for (const alias of entry.aliases ?? []) {
      const owner = aliasOwner.get(alias);
      if (owner !== undefined && owner !== entry.slug) {
        issues.push(`entries: alias "${alias}" is claimed by both "${owner}" and "${entry.slug}"`);
      } else if (bySlug.has(alias) && bySlug.get(alias) !== entry) {
        issues.push(`entries: alias "${alias}" on "${entry.slug}" collides with another entry's slug`);
      }
      aliasOwner.set(alias, entry.slug);
    }
  }

  const expectedBacklinks = new Map<string, string[]>(entries.map((entry) => [entry.slug, []]));
  for (const entry of entries) {
    const label = `entries (slug "${entry.slug}")`;
    for (const target of entry.outgoing) {
      if (target === entry.slug) issues.push(`${label}.outgoing: must not link to itself`);
      else if (!bySlug.has(target)) issues.push(`${label}.outgoing: "${target}" does not resolve to a published entry`);
      else expectedBacklinks.get(target)?.push(entry.slug);
    }
    for (const source of entry.backlinks) {
      if (source === entry.slug) issues.push(`${label}.backlinks: must not link to itself`);
      else if (!bySlug.has(source)) issues.push(`${label}.backlinks: "${source}" does not resolve to a published entry`);
    }
  }

  for (const entry of entries) {
    const expected = (expectedBacklinks.get(entry.slug) ?? []).sort();
    const actual = [...entry.backlinks].sort();
    if (expected.length !== actual.length || expected.some((slug, index) => slug !== actual[index])) {
      issues.push(
        `entries (slug "${entry.slug}").backlinks: must be the exact inverse of outgoing links ` +
          `(expected [${expected.join(', ')}], got [${entry.backlinks.join(', ')}])`,
      );
    }
  }
}

/**
 * Validate a parsed content artifact.
 *
 * @throws {ContentValidationError} listing every violation, each naming the
 * offending entry and field.
 */
export function validateArtifact(data: unknown, source = 'content artifact'): ContentArtifact {
  const issues: string[] = [];

  if (!isPlainObject(data)) throw new ContentValidationError(source, ['artifact: must be an object']);

  for (const field of Object.keys(data)) {
    if (field !== 'version' && field !== 'entries') issues.push(`${field}: unknown field is not allowed`);
  }
  if (data['version'] !== SCHEMA_VERSION) {
    issues.push(`version: must be ${SCHEMA_VERSION}, got ${JSON.stringify(data['version'])}`);
  }

  const rawEntries = data['entries'];
  if (!Array.isArray(rawEntries)) issues.push('entries: must be an array');
  else if (rawEntries.length > MAX_ENTRIES) {
    issues.push(
      `entries: has ${rawEntries.length} entries, over the limit of ${MAX_ENTRIES} ` +
        '(see MAX_ENTRIES: one rendered page and one search record per entry)',
    );
  } else {
    const valid: ContentEntry[] = [];
    for (const [index, entry] of rawEntries.entries()) {
      const checked = checkEntry(entry, index, issues);
      if (checked) valid.push(checked);
    }
    if (valid.length === rawEntries.length) checkCorpus(valid, issues);
  }

  if (issues.length > 0) throw new ContentValidationError(source, issues);
  return data as unknown as ContentArtifact;
}
