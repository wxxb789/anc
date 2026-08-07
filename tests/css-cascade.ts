/**
 * Parsers for the built stylesheet and HTML.
 *
 * These back the CSP and no-JavaScript gates in `built-output.test.ts`, so they
 * are a security-relevant surface in their own right and carry their own
 * adversarial tests in `css-cascade.test.ts` — the same treatment TK-01 gave the
 * privacy scanner. Not a `.test.ts` file, so `node --test` does not run it.
 *
 * Every parser is deliberately biased toward a false FAIL over a false PASS: a
 * noisy gate is fixed in a minute, a gate that silently misses a real defect is
 * worse than no gate.
 */

export type Specificity = [id: number, classes: number, types: number];

/** One rule as it survives minification, with the at-rules enclosing it. */
export interface Rule {
  selector: string;
  body: string;
  /** The prelude of each enclosing at-rule, outermost first. */
  conditions: string[];
  /** Document order, so an equal-specificity tie can be resolved. */
  order: number;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * At-rules whose block contains nested rules rather than declarations.
 *
 * Everything else that opens a block — `@font-face`, `@page`, `@property`,
 * `@counter-style`, `@keyframes` — holds declarations, so its body must be
 * skipped whole. Treating one as a container leaves its declarations
 * unconsumed, and they then become the prelude of the next rule: `@page{margin:
 * 1cm}` followed by the print block makes every print rule look unconditional.
 */
const CONTAINER_AT_RULES = new Set(['@media', '@supports', '@layer', '@container', '@scope']);

/** Index just past the `}` matching the `{` at `from`, ignoring braces in strings. */
function blockEnd(source: string, from: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = from; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote !== undefined) {
      if (character === quote && source[index - 1] !== '\\') quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

/**
 * Every style rule in the sheet, each tagged with the at-rules that enclose it.
 * Brace-matched rather than pattern-matched, so nesting of any depth is read
 * correctly — a rule buried two at-rules deep must not be mistaken for a
 * top-level one — and quote-aware throughout, so a `}` inside `content: "}"`
 * or a `url()` does not end a rule early and collapse the whole sheet.
 */
export function rules(css: string): Rule[] {
  const source = stripComments(css);
  const found: Rule[] = [];
  const open: { prelude: string; end: number }[] = [];
  let prelude = '';
  let quote: string | undefined;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;

    if (quote !== undefined) {
      prelude += character;
      if (character === quote && source[index - 1] !== '\\') quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      prelude += character;
      continue;
    }

    if (character === ';' && prelude.trimStart().startsWith('@')) {
      prelude = ''; // A statement at-rule such as `@import`, which opens no block.
      continue;
    }

    if (character === '{') {
      const head = prelude.trim();
      prelude = '';
      const end = blockEnd(source, index);

      if (head.startsWith('@')) {
        const name = /^@[\w-]*/.exec(head)?.[0].toLowerCase() ?? '';
        if (CONTAINER_AT_RULES.has(name)) open.push({ prelude: head, end });
        else index = end - 1; // Declarations, not rules: skip the whole block.
        continue;
      }

      // A style rule's body holds declarations only, so it ends at its own `}`.
      found.push({
        selector: head,
        body: source.slice(index + 1, Math.max(index + 1, end - 1)),
        conditions: open.map((frame) => frame.prelude),
        order: found.length,
      });
      index = end - 1;
      continue;
    }

    if (character === '}') {
      open.pop();
      continue;
    }

    prelude += character;
  }

  return found;
}

/**
 * Whether an at-rule condition definitely excludes the screen.
 *
 * Only print does. A width query, a preference query, an `@supports` — all can
 * apply to some real reader on screen, so all are kept. That direction matters:
 * keeping a block can only add rules to the cascade the gate examines, while
 * dropping one could hide the very rule that breaks the page. Reduced-motion is
 * deliberately *not* excluded even though this sheet's reduced-motion block
 * touches only animation timing: a later block might not.
 */
export function excludesDefaultScreen(condition: string): boolean {
  if (!/^@media\b/i.test(condition)) return false;
  const queries = condition.replace(/^@media/i, '').split(',');
  // A media list is a union: if any query can apply on screen, the block does.
  return queries.every((query) => {
    const text = query.trim().toLowerCase();
    if (/(?:^|\s)not\s/.test(text)) return false; // `not print` applies on screen.
    return /(?:^|[\s(])print(?:$|[\s)])/.test(text) && !/\bscreen\b/.test(text);
  });
}

/** A rule that applies on screen. */
export function appliesByDefault(rule: Rule): boolean {
  return !rule.conditions.some(excludesDefaultScreen);
}

/** Split a selector list at top-level commas only. */
export function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;

  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index]!;
    if (quote !== undefined) {
      if (character === quote && selector[index - 1] !== '\\') quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(selector.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** Length of the identifier at `from`, treating `\x` as one escaped character. */
function identifierLength(selector: string, from: number): number {
  let index = from;
  while (index < selector.length) {
    if (selector[index] === '\\') index += 2;
    else if (/[\w-]/.test(selector[index]!)) index += 1;
    else break;
  }
  return index - from;
}

/** Index just past the `)` or `]` matching the one at `from`. */
function closingIndex(selector: string, from: number, open: string, close: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = from; index < selector.length; index += 1) {
    const character = selector[index]!;
    if (quote !== undefined) {
      if (character === quote && selector[index - 1] !== '\\') quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return selector.length;
}

function add(total: Specificity, other: Specificity): void {
  for (const column of [0, 1, 2] as const) total[column] += other[column];
}

function higher(a: Specificity, b: Specificity): Specificity {
  for (const column of [0, 1, 2] as const) {
    if (a[column] !== b[column]) return a[column]! > b[column]! ? a : b;
  }
  return a;
}

/** Pseudo-elements that predate `::` and are still written with one colon. */
const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);

/**
 * CSS specificity as (id, class/attribute/pseudo-class, type/pseudo-element).
 *
 * Follows the selectors spec on the parts that decide this gate: `:where()`
 * contributes nothing, `:is()`/`:not()`/`:has()` contribute their most specific
 * argument, a pseudo-element counts in the type column — including the four
 * legacy one-colon spellings — and type selectors are matched
 * case-insensitively because HTML type selectors are.
 */
export function specificity(selector: string): Specificity {
  const total: Specificity = [0, 0, 0];
  let index = 0;

  while (index < selector.length) {
    const character = selector[index]!;

    if (character === '\\') {
      // An escaped character is part of an identifier, not a new component.
      index += 2;
    } else if (character === '#') {
      total[0] += 1;
      index += 1 + identifierLength(selector, index + 1);
    } else if (character === '.') {
      total[1] += 1;
      index += 1 + identifierLength(selector, index + 1);
    } else if (character === '[') {
      total[1] += 1;
      index = closingIndex(selector, index, '[', ']');
    } else if (character === ':') {
      const isDoubleColon = selector[index + 1] === ':';
      const nameStart = index + (isDoubleColon ? 2 : 1);
      const name = /^[\w-]*/.exec(selector.slice(nameStart))?.[0] ?? '';
      let next = nameStart + name.length;
      const argument = selector[next] === '(' ? selector.slice(next + 1, closingIndex(selector, next, '(', ')') - 1) : undefined;
      if (argument !== undefined) next = closingIndex(selector, next, '(', ')');

      const lower = name.toLowerCase();
      if (isDoubleColon || LEGACY_PSEUDO_ELEMENTS.has(lower)) total[2] += 1;
      else if (lower === 'where') {
        /* Contributes nothing, by definition. */
      } else if (argument !== undefined && (lower === 'is' || lower === 'not' || lower === 'has' || lower === 'matches')) {
        const best = splitSelectorList(argument).map(specificity).reduce(higher, [0, 0, 0]);
        add(total, best);
      } else if (argument !== undefined && (lower === 'nth-child' || lower === 'nth-last-child')) {
        // `:nth-child(n of <list>)` counts the selector list too.
        total[1] += 1;
        const list = /\bof\b(.*)$/is.exec(argument)?.[1];
        if (list) add(total, splitSelectorList(list).map(specificity).reduce(higher, [0, 0, 0]));
      } else {
        total[1] += 1;
      }
      index = next;
    } else if (/[A-Za-z_]/.test(character)) {
      total[2] += 1;
      index += identifierLength(selector, index);
    } else {
      index += 1; // A combinator, `*`, or whitespace: no contribution.
    }
  }

  return total;
}

/** Whether declaration `a` wins over `b`, given each rule's document order. */
export function wins(
  a: { specificity: Specificity; important: boolean; order: number },
  b: { specificity: Specificity; important: boolean; order: number },
): boolean {
  if (a.important !== b.important) return a.important;
  for (const column of [0, 1, 2] as const) {
    if (a.specificity[column] !== b.specificity[column]) return a.specificity[column]! > b.specificity[column]!;
  }
  return a.order > b.order;
}

/** A declaration's value and importance, or undefined when the rule omits it. */
export function declaration(body: string, property: string): { value: string; important: boolean } | undefined {
  const pattern = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`, 'i');
  const match = pattern.exec(body);
  if (!match) return undefined;
  const raw = match[1]!.trim();
  const important = /!\s*important$/i.test(raw);
  return { value: raw.replace(/!\s*important$/i, '').trim(), important };
}

/**
 * CSS lengths that resolve to a fixed number of pixels.
 *
 * `ch` and `ex` vary by font, so they use a conservative lower bound: a wider
 * font makes the real box wider, never narrower, so under-estimating here can
 * only miss a defect at the margin rather than invent one.
 */
const UNIT_PX: Readonly<Record<string, number>> = {
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  rem: 16,
  em: 16,
  ch: 8,
  ex: 8,
};

/** A value that can resolve narrower than any fixed length it names. */
const SHRINKABLE =
  /min\(|clamp\(|%|auto|inherit|initial|unset|revert|fit-content|min-content|100vw|var\(/;

/** A `calc()` whose only fixed terms are subtracted, so it cannot exceed its base. */
const ONLY_SUBTRACTS = /[\w%)]\s+-\s+[\d.]/;

/**
 * The widest fixed length a value commits to, or undefined when it can shrink
 * below `limit`.
 *
 * `max()` returns at least its largest argument, and `calc()` that adds to a
 * percentage is the classic overflow bug, so both are measured by their widest
 * fixed term rather than dismissed as flexible for containing a `%`.
 */
export function fixedWidthOver(value: string, limit: number): number | undefined {
  const text = value.trim();
  const forcesWidth = /^max\(/i.test(text) || (/^calc\(/i.test(text) && !ONLY_SUBTRACTS.test(text));
  if (!forcesWidth && SHRINKABLE.test(text)) return undefined;

  const terms = forcesWidth ? (text.match(/[\d.]+[a-z]+/gi) ?? []) : [text];
  let widest: number | undefined;
  for (const term of terms) {
    const length = /^(-?[\d.]+)([a-z]+)$/i.exec(term.trim());
    const factor = length && UNIT_PX[length[2]!.toLowerCase()];
    if (!factor) continue;
    const px = Number(length[1]) * factor;
    if (px > limit && (widest === undefined || px > widest)) widest = px;
  }
  return widest;
}

/** The `min-width` floor an at-rule condition imposes, in pixels. */
export function minWidthFloor(condition: string): number {
  const query = /(?:min-width|width\s*>=)\s*:?\s*([\d.]+)([a-z]+)/i.exec(condition);
  if (!query) return 0;
  return Number(query[1]) * (UNIT_PX[query[2]!.toLowerCase()] ?? 1);
}

/**
 * Every start tag in the document, verbatim.
 *
 * A quoted attribute value is consumed as part of finding the tag boundary, so
 * a `>` inside one does not end the tag. A scanner that stops there sees a
 * truncated tag and misses whatever followed — an `onclick=` two attributes
 * later, or the `id` of a control.
 */
export function* rawStartTags(html: string): Generator<string> {
  // An unquoted attribute value containing a bare `"` would still confuse this,
  // but that is invalid HTML and Astro escapes what it interpolates.
  const pattern = /<[a-zA-Z](?:"[^"]*"|'[^']*'|[^>])*>/g;
  for (const [tag] of html.matchAll(pattern)) yield tag;
}

/**
 * Every start tag with its quoted attribute values blanked, so prose inside a
 * value cannot be read as an attribute name.
 *
 * Blanking is one alternation rather than two passes, so whichever quote opens
 * first closes first. Two passes let a `"` inside a single-quoted value open a
 * phantom double-quoted region that swallows the real attributes after it,
 * which is the same miss in a different disguise.
 */
export function* startTags(html: string): Generator<string> {
  for (const tag of rawStartTags(html)) {
    yield tag.replace(/"[^"]*"|'[^']*'/g, (value) => value[0]! + value[0]!);
  }
}
