/**
 * The JavaScript ceiling for one rendered page.
 *
 * Kept as a module rather than inline in `built-routes.test.ts` so the gate and
 * adversarial tests cross the same seam. The previous source-reading test only
 * checked that marker constant names appeared near the budget table; it never
 * executed the decision and could not prove an authored class or prose string
 * earned no allowance.
 */

import { MATH_MODE } from '../../src/lib/math-mode.ts';
import {
  MARKED_ROOT,
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
 * The measured floor for the one client runtime: a client math page carries
 * Temml's chunk. In `build-time` math the runtime resolves to an empty stub, so
 * no page earns the allowance. Diagrams have no client runtime at all — they
 * are rendered to SVG at build time — so they have no floor to grant.
 *
 * Exported because `tests/math-and-diagrams.test.ts`'s site-wide total adds the
 * floor to its own allowance, and two tables of the same measured number is one
 * table that forgets to move.
 */
export const CLIENT_RUNTIME_FLOOR_BYTES: Readonly<Record<typeof RENDERED_MATH, number>> = {
  [RENDERED_MATH]: 220_000,
};

const RUNTIME_ALLOWANCES: readonly RuntimeAllowance[] = [
  { kind: RENDERED_MATH, mode: MATH_MODE, bytes: CLIENT_RUNTIME_FLOOR_BYTES[RENDERED_MATH], what: 'math' },
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
