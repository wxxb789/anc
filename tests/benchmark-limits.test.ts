import { describe, expect, it } from 'vitest';

import { benchmarkExitCode } from '../scripts/benchmark-limits.ts';

describe('benchmark-limits exit status', () => {
  it('requires every browser control and the client-bound test to pass', () => {
    const clientBoundTest = { status: 'pass' as const };

    expect(benchmarkExitCode([{ status: 'pass' }], clientBoundTest)).toBe(0);
    expect(benchmarkExitCode([{ status: 'fail' }], clientBoundTest)).toBe(1);
    expect(benchmarkExitCode([{ status: 'not-implemented' }], clientBoundTest)).toBe(1);
    expect(benchmarkExitCode([{ status: 'pass' }], { status: 'fail' })).toBe(1);
  });
});
