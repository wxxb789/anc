/** Nearest-rank summaries and exact-count assertions for the snapshot benchmark. */

export function round(value: number, places: number): number {
  return Number(value.toFixed(places));
}

/** Nearest-rank percentile over the finite values; method stated in the report. */
function percentile(values: readonly number[], fraction: number): number | null {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return round(sorted[rank]!, 3);
}

export interface Series {
  n: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
  values: number[];
}

export function seriesOf(values: readonly number[]): Series {
  const finite = values.filter((value) => Number.isFinite(value)).map((value) => round(value, 3));
  return {
    n: finite.length,
    min: percentile(finite, 0),
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: percentile(finite, 1),
    values: finite,
  };
}

export interface NumericDistribution {
  n: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
  mean: number | null;
  total: number | null;
}

export function distributionOf(values: readonly number[]): NumericDistribution {
  const finite = values.filter((value) => Number.isFinite(value));
  const total = finite.reduce((sum, value) => sum + value, 0);
  return {
    n: finite.length,
    min: percentile(finite, 0),
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: percentile(finite, 1),
    mean: finite.length === 0 ? null : round(total / finite.length, 3),
    total: finite.length === 0 ? null : round(total, 3),
  };
}

export interface FieldLengthDistribution extends NumericDistribution {
  /** Values absent from their owning row or collection (not a zero-length value). */
  absent: number;
  /** Present values whose length is exactly zero. */
  empty: number;
}

/** Summarize string lengths while keeping missing and empty values distinct. */
export function fieldLengthDistribution(
  values: readonly (string | null | undefined)[],
  additionalAbsent = 0,
): FieldLengthDistribution {
  const present = values.filter((value): value is string => typeof value === 'string');
  return {
    ...distributionOf(present.map((value) => value.length)),
    absent: values.filter((value) => value === null || value === undefined).length + additionalAbsent,
    empty: present.filter((value) => value.length === 0).length,
  };
}

/** Fail closed when a UI operation did not produce exactly its expected events. */
export function assertExactEventCount(label: string, observed: number, expected: number): void {
  if (observed !== expected) throw new Error(`${label}: expected ${expected} events, observed ${observed}`);
}

export function assertExactSampleCount(label: string, observed: number, expected: number): void {
  if (observed !== expected) throw new Error(`${label}: expected ${expected} successful samples, observed ${observed}`);
}

export function assertExactlyOneControl(label: string, observed: number): void {
  if (observed !== 1) throw new Error(`${label}: expected exactly one control, observed ${observed}`);
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
