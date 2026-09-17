/**
 * `.github/workflows/action-parity.yml` is evidence no other gate can see.
 *
 * It is the one workflow that exercises the shipped composite Action against a
 * synthetic notes repository, and `pnpm run verify` does not run it — the
 * browser gates never read a workflow file, and `tests/verify.test.ts` is
 * scoped to `verify.yml` on purpose. A workflow with no gate is one edit away
 * from becoming the weaker chain the goal row forbids: publishing with
 * `anc build` directly, pre-installing the toolchain so the Action's own
 * install steps never run, or growing a deploy step. This file holds the
 * properties the goal states, over the parsed workflow rather than its text.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WORKFLOW_PATH = '.github/workflows/action-parity.yml';
const TEXT = readFileSync(join(ROOT, WORKFLOW_PATH), 'utf8');

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  'continue-on-error'?: boolean;
}

interface Job {
  'runs-on'?: string;
  steps?: Step[];
}

interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  jobs?: Record<string, Job>;
}

const WORKFLOW = parse(TEXT) as Workflow;
const JOBS = Object.entries(WORKFLOW.jobs ?? {});

/** Every step, tagged with the job that owns it. */
const STEPS = JOBS.flatMap(([job, definition]) =>
  (definition.steps ?? []).map((step) => ({ job, step })),
);

/** The workflow with comment lines removed, for negative rules. */
const CODE = TEXT.split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

test('the workflow runs on pull requests and on demand', () => {
  assert.deepEqual(
    Object.keys(WORKFLOW.on ?? {}).sort(),
    ['pull_request', 'workflow_dispatch'],
    `${WORKFLOW_PATH}: the evidence must be reachable from a pull request and by hand`,
  );
});

test('the workflow can read and cannot write, and needs no secret', () => {
  assert.deepEqual(
    WORKFLOW.permissions,
    { contents: 'read' },
    `${WORKFLOW_PATH}: the token must be read-only; deployment is the user's step, not this workflow's`,
  );
  assert.doesNotMatch(CODE, /secrets\./, `${WORKFLOW_PATH}: the parity path needs no secret`);
});

test('every job runs on the Action’s supported Linux runner', () => {
  for (const [job, definition] of JOBS) {
    assert.equal(
      definition['runs-on'],
      'ubuntu-latest',
      `${WORKFLOW_PATH}: ${job} must run where the checksum-pinned scanner installer is supported`,
    );
  }
});

test('the build step is the shipped Action, over a committed reviewed set', () => {
  const foreign = WORKFLOW.jobs?.['foreign-notes'];
  assert.ok(foreign, `${WORKFLOW_PATH}: the foreign-notes job is missing`);
  const steps = foreign.steps ?? [];

  // `anc review` itself needs the generator's dependencies, which only the
  // Action installs; the ledger is committed by the fixture instead. What must
  // remain true is that a reviewed set is committed *before* the Action runs,
  // because the Action always builds `--release` and refuses an unreviewed
  // set. `tests/action-parity.test.ts`'s sibling assertions hold the fixture to
  // writing that ledger.
  const actionIndex = steps.findIndex((step) => step.uses === './generator');
  assert.ok(actionIndex >= 0, `${WORKFLOW_PATH}: the Action under test is never invoked`);

  const createIndex = steps.findIndex((step) => step.run?.includes('action-parity-fixture.mjs'));
  assert.ok(createIndex >= 0, `${WORKFLOW_PATH}: the fixture that commits the reviewed set never runs`);
  assert.ok(
    createIndex < actionIndex,
    `${WORKFLOW_PATH}: the reviewed set must be committed before the Action builds`,
  );

  const assertIndex = steps.findIndex((step) => step.run?.includes('assert-action-artifact.mjs'));
  assert.ok(
    assertIndex > actionIndex,
    `${WORKFLOW_PATH}: the produced artifact must be asserted after the Action runs`,
  );
});

test('the Action’s own install and scanner steps are the ones exercised', () => {
  // A workflow that installs pnpm, or the scanner, or dependencies before the
  // Action would pass while the Action's own chain silently rotted. The Action
  // installs its toolchain itself; nothing here may do it first.
  for (const { step } of STEPS) {
    assert.doesNotMatch(
      step.run ?? '',
      /pnpm\s+(?:install|i)\b|install-gitleaks|npm install -g/,
      `${WORKFLOW_PATH}: ${step.name ?? step.uses ?? 'a step'} pre-installs what the Action must install itself`,
    );
  }
  for (const { step } of STEPS) {
    if (step.uses === undefined) continue;
    assert.ok(
      ['actions/checkout@v5', 'actions/setup-node@v5', './generator'].includes(step.uses),
      `${WORKFLOW_PATH}: unexpected action ${step.uses}; anything else can deploy or change the chain`,
    );
  }
  const checkout = STEPS.filter(({ step }) => step.uses === 'actions/checkout@v5');
  assert.ok(checkout.length > 0, `${WORKFLOW_PATH}: the generator is never checked out`);
  for (const { step } of checkout) {
    assert.equal(
      step.with?.['path'],
      'generator',
      `${WORKFLOW_PATH}: the generator must live under generator/, or uses: ./generator cannot resolve`,
    );
  }
  for (const { step } of STEPS) {
    if (step.uses !== 'actions/setup-node@v5') continue;
    assert.equal(
      step.with?.['node-version-file'],
      'generator/.nvmrc',
      `${WORKFLOW_PATH}: the runtime belongs to .nvmrc, not a second literal pin`,
    );
  }
});

test('no step builds outside the Action or deploys anything', () => {
  for (const { step } of STEPS) {
    const run = step.run ?? '';
    assert.doesNotMatch(
      run,
      /anc\.mjs\s+build|--release/,
      `${WORKFLOW_PATH}: ${step.name ?? 'a step'} builds outside the Action, which is the weaker chain the goal row forbids`,
    );
  }
  assert.doesNotMatch(
    CODE,
    /deploy|wrangler|cloudflare|upload-pages-artifact|npm publish/i,
    `${WORKFLOW_PATH}: the parity workflow must not deploy or publish`,
  );
});

test('the shallow-clone control proves the Action’s first step can fail', () => {
  const shallow = WORKFLOW.jobs?.['shallow-clone-refusal'];
  assert.ok(shallow, `${WORKFLOW_PATH}: the negative control job is missing`);
  const steps = shallow.steps ?? [];
  const guarded = steps.find((step) => step.uses === './generator');
  assert.equal(guarded?.['continue-on-error'], true, `${WORKFLOW_PATH}: a refused shallow clone would fail the job before it can be asserted`);
  assert.ok(guarded?.['id'], `${WORKFLOW_PATH}: the controlled step needs an id for its outcome`);
  const assertion = steps.find((step) => step.run?.includes('steps.'));
  assert.ok(assertion, `${WORKFLOW_PATH}: the control never asserts the guarded step failed`);
  assert.match(
    assertion.run ?? '',
    /failure/,
    `${WORKFLOW_PATH}: the control must require the outcome to be a failure, not merely record it`,
  );
});

test('the assertion scripts exist and re-derive what they claim', () => {
  const fixture = readFileSync(join(ROOT, '.github/scripts/action-parity-fixture.mjs'), 'utf8');
  const assertion = readFileSync(join(ROOT, '.github/scripts/assert-action-artifact.mjs'), 'utf8');
  assert.match(fixture, /publish: false/, 'the fixture no longer withholds a note by frontmatter');
  assert.match(fixture, /exclude:/, 'the fixture no longer withholds a path by pattern');
  assert.match(fixture, /\.publish-set\.json/, 'the fixture no longer commits a reviewed publish set');
  assert.match(
    fixture,
    /slugs:\s*\['second',\s*'welcome'\]/,
    'the fixture no longer records the exact public set, so the release gate would compare against nothing',
  );
  for (const instrument of ['node:sqlite', 'createHash', 'gunzipSync']) {
    assert.ok(
      assertion.includes(instrument),
      `the artifact check no longer re-derives via ${instrument}, so it could pass on a wrong artifact`,
    );
  }
  assert.match(
    CODE,
    /node generator\/\.github\/scripts\/assert-action-artifact\.mjs/,
    `${WORKFLOW_PATH}: the artifact check is never run`,
  );
});
