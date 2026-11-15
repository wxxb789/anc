/**
 * The JavaScript ceiling for one rendered page.
 *
 * Kept as a module rather than inline in `built-routes.test.ts` so the gate and
 * adversarial tests cross the same seam. The previous source-reading test only
 * checked that marker constant names appeared near the budget table; it never
 * executed the decision and could not prove an authored class or prose string
 * earned no allowance.
 */

import { DIAGRAM_MODE } from '../../src/lib/diagram-mode.ts';
import { MATH_MODE } from '../../src/lib/math-mode.ts';
import {
  MARKED_ROOT,
  RENDERED_DIAGRAM,
  RENDERED_MATH,
  type RenderedKind,
} from '../../src/lib/rendered-marker.ts';

export const BASE_SCRIPT_BUDGET_BYTES = 40_000;

interface RuntimeAllowance {
  kind: RenderedKind;
  mode: 'build-time' | 'client';
  bytes: number;
  what: string;
}

/**
 * These are measured floors, not aspirations: a client math page carries
 * Temml's chunk and a client diagram page Mermaid's grammar set. In build-time
 * mode Astro aliases both runtimes to empty stubs, so no page earns either
 * allowance.
 *
 * Exported because `tests/math-and-diagrams.test.ts`'s site-wide total adds the
 * floor of each *selected* client mode to its own allowance, and two tables of
 * the same measured number is one table that forgets to move.
 */
export const CLIENT_RUNTIME_FLOOR_BYTES: Readonly<Record<RenderedKind, number>> = {
  [RENDERED_MATH]: 220_000,
  [RENDERED_DIAGRAM]: 900_000,
};

const RUNTIME_ALLOWANCES: readonly RuntimeAllowance[] = [
  { kind: RENDERED_MATH, mode: MATH_MODE, bytes: CLIENT_RUNTIME_FLOOR_BYTES[RENDERED_MATH], what: 'math' },
  {
    kind: RENDERED_DIAGRAM,
    mode: DIAGRAM_MODE,
    bytes: CLIENT_RUNTIME_FLOOR_BYTES[RENDERED_DIAGRAM],
    what: 'a diagram',
  },
];

export interface ScriptBudget {
  ceiling: number;
  because: string;
  earned: string[];
}

/**
 * Calculate the ceiling from renderer-owned root markers in the page.
 *
 * An absent marker fails tight and earns nothing. `MARKED_ROOT` requires the
 * marker in an element attribute position, so an authored class, a bare marker
 * string in prose, and an encoded spelling in text all remain at the base.
 */
export function scriptBudgetFor(html: string): ScriptBudget {
  const earned = RUNTIME_ALLOWANCES.filter(
    (allowance) => allowance.mode === 'client' && MARKED_ROOT(allowance.kind).test(html),
  );
  return {
    ceiling: BASE_SCRIPT_BUDGET_BYTES + earned.reduce((total, allowance) => total + allowance.bytes, 0),
    because:
      earned.length === 0
        ? 'the base budget, since this page carries no client-rendered construct'
        : `${BASE_SCRIPT_BUDGET_BYTES} B base plus ${earned.map((allowance) => allowance.what).join(' and ')}`,
    earned: earned.map((allowance) => allowance.what),
  };
}
