/**
 * Render one diagram in a fresh process and print it, for the cross-process
 * gates.
 *
 * A separate process is the only way to check the properties that matter.
 * "The same source produces the same bytes" is a claim about a *fresh* process,
 * not about two calls in one: a renderer keeping any module-level state would
 * share whatever the first call left behind, which is exactly what would hide
 * the defect.
 *
 * The entry point is `src/lib/pele-render.ts`, the one build-time renderer this
 * tree has, and the SVG goes to stdout unadorned: this script's only spawn site
 * (`tests/math-and-diagrams.test.ts:281`, the determinism gate) compares the
 * full bytes of two runs, so there is nothing a flag could usefully switch.
 *
 * It lives in `tests/support/` rather than `scripts/` because it is a test
 * fixture, not a harness command: `scripts/` holds the build steps
 * `package.json` names, and adding another for one assertion is how a clean
 * harness becomes a junk drawer.
 */

const ROOT = new URL('../../', import.meta.url);

const source = process.argv[2];
if (source === undefined) {
  console.error('usage: node tests/support/render-diagram.ts <diagram source>');
  process.exit(2);
}

// `await import` rather than a static import, deliberately: a static import is
// hoisted, so it would load the renderer and its parser graph before the usage
// check above could print and exit. Only a valid invocation should pay that.
const module = await import(new URL('src/lib/pele-render.ts', ROOT).href);
const svg: string = await module.renderDiagram(source, 'determinism-probe', 'Probe diagram');
process.stdout.write(svg);
