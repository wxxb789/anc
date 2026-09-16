/**
 * Drop Node's `ExperimentalWarning: SQLite is an experimental feature…`.
 *
 * Useful while developing this tool, harmful on its surfaces: a packaged build's
 * stderr is compared to the exact lines it composes, and `anc preview` is
 * asserted to print nothing there. The filter is narrow — it drops this one
 * message and passes every other warning through — and idempotent, so a caller
 * may install it more than once.
 */

let installed = false;

export function suppressSqliteWarning(): void {
  if (installed) return;
  installed = true;
  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === 'string' ? warning : warning.message;
    if (message.includes('SQLite is an experimental feature')) return;
    (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}
