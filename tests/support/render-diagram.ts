/**
 * Render one diagram and print it, for the cross-process determinism gate.
 *
 * A separate process is the only way to check the property that matters:
 * Mermaid keeps module-level counters and seeds gitgraph's commit hashes from
 * `Math.random`, so "the same source produces the same bytes" is a claim about
 * a *fresh* process, not about two calls in one. Two calls in one process share
 * whatever state the first left behind, which is exactly what would hide the
 * defect.
 *
 * It lives in `tests/support/` rather than `scripts/` because it is a test
 * fixture, not a harness command: `scripts/` holds the five build steps
 * `package.json` names, and adding a sixth for one assertion is how a clean
 * harness becomes a junk drawer.
 */

import { renderDiagram } from '../../src/lib/mermaid-render.ts';

const source = process.argv[2];
if (source === undefined) {
  console.error('usage: node tests/support/render-diagram.ts <diagram source>');
  process.exit(2);
}

process.stdout.write(await renderDiagram(source, 'determinism-probe', 'Probe diagram'));
