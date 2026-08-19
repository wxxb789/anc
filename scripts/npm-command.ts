/** Run npm portably without Node's deprecated shell-plus-args form. */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

function quoteForCmd(value: string): string {
  if (!/[\s&|<>^]/.test(value)) return value;
  return '"' + value.replaceAll('"', '""') + '"';
}

/** npm is a .CMD shim on Windows and a directly executable program elsewhere. */
export function spawnNpm(args: string[], cwd: string): SpawnSyncReturns<string> {
  const common = { cwd, encoding: 'utf8' as const };
  if (process.platform !== 'win32') return spawnSync('npm', args, common);
  const command = 'npm ' + args.map(quoteForCmd).join(' ');
  return spawnSync(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/c', command], common);
}
