/**
 * Render one diagram in a fresh process and print it or its digest, for the
 * cross-process gates.
 *
 * A separate process is the only way to check the properties that matter.
 * "The same source produces the same bytes" is a claim about a *fresh* process,
 * not about two calls in one: Mermaid keeps module-level counters and seeds
 * gitgraph's commit hashes from `Math.random`, so two calls in one process
 * share whatever state the first left behind, which is exactly what would hide
 * the defect. And "only the selected adapter was loaded" is a claim about the
 * module graph of a run, which only a loader hook can observe.
 *
 * `--adapter <repo-relative path>` renders through that module instead of the
 * dispatcher, so a gate can compare the seam against the adapter it dispatches
 * to. `--hash` prints the SHA-256 of the result instead of the result.
 * `--resolves` installs a resolve-recording loader hook whose module appends
 * every specifier the run requested, one bare line each, to the file named by
 * `DIAGRAM_RESOLVE_LOG` — the caller reads that file, and the only stderr write
 * is `render error: …`; a failing render is reported, not thrown, in that mode,
 * because the module graph of the failure path is what the caller is asking
 * about.
 *
 * It lives in `tests/support/` rather than `scripts/` because it is a test
 * fixture, not a harness command: `scripts/` holds the five build steps
 * `package.json` names, and adding a sixth for one assertion is how a clean
 * harness becomes a junk drawer.
 */

import { createHash } from 'node:crypto';
import { register } from 'node:module';

const ROOT = new URL('../../', import.meta.url);

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv.splice(index, 2)[1];
};
const hashes = argv.includes('--hash');
if (hashes) argv.splice(argv.indexOf('--hash'), 1);
const recordResolves = argv.includes('--resolves');
if (recordResolves) argv.splice(argv.indexOf('--resolves'), 1);

const adapter = flag('--adapter');
const source = argv[0];
if (source === undefined) {
  console.error('usage: node tests/support/render-diagram.ts [--adapter <path>] [--hash] [--resolves] <diagram source>');
  process.exit(2);
}

function recordResolveGraph(): void {
  const log = process.env['DIAGRAM_RESOLVE_LOG'];
  if (log === undefined) throw new Error('--resolves needs DIAGRAM_RESOLVE_LOG');
  // Appending from the hook: `module.register` runs the hook module on its own
  // thread, so a module-level array here is not the array the hook writes to.
  const hook = [
    "import { appendFileSync } from 'node:fs';",
    'const log = process.env.DIAGRAM_RESOLVE_LOG;',
    'export async function resolve(specifier, context, next) {',
    "  appendFileSync(log, specifier + '\\n');",
    '  return next(specifier, context);',
    '}',
  ].join('\n');
  register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`), import.meta.url);
}

if (recordResolves) recordResolveGraph();

try {
  // `await import` rather than a static import, deliberately: the specifier is
  // runtime-selected by `--adapter`, and the resolve-recording hook above has to
  // be installed before the target module's graph is requested — a static import
  // would have run first and recorded nothing.
  const module = adapter === undefined
    ? await import(new URL('src/lib/diagram-engine.ts', ROOT).href)
    : await import(new URL(adapter, ROOT).href);
  const svg: string = await module.renderDiagram(source, 'determinism-probe', 'Probe diagram');
  process.stdout.write(hashes ? createHash('sha256').update(svg).digest('hex') : svg);
} catch (error) {
  const message = error instanceof Error ? `${error.name}: ${error.message.split('\n')[0]}` : String(error);
  if (!recordResolves) throw error;
  console.error(`render error: ${message}`);
}
