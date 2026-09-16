/**
 * The one place ANC loads `node:sqlite`, with the experimental-feature warning
 * filtered out.
 *
 * Every importer goes through here, so the warning is suppressed wherever it
 * would otherwise fire. The load is a `createRequire` call in the module body
 * rather than a re-export, because a re-export would be evaluated *before* this
 * body runs and the filter would be installed too late.
 */

import { createRequire } from 'node:module';
import { suppressSqliteWarning } from './sqlite-warning.ts';

suppressSqliteWarning();

const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** The synchronous SQLite connection type, re-exported under one home. */
export type DatabaseSync = InstanceType<(typeof import('node:sqlite'))['DatabaseSync']>;

export const DatabaseSync = sqlite.DatabaseSync;
