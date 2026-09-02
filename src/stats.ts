/**
 * Sample-size annotation for win-rate style aggregates. Win rates from small
 * samples swing wildly (a 98-game 36% has a 95% CI of roughly ±9.5pp), so
 * every aggregate row carries its confidence half-width and a low-sample flag
 * to keep agents from stating noise as fact.
 */

/** Below this many games a win rate is direction-only, not a precise number. */
export const LOW_SAMPLE_THRESHOLD = 200;

/** Wilson score interval (95%) half-width in percentage points. */
export function wilson95HalfWidthPp(games: number, wins: number): number | undefined {
  if (!Number.isFinite(games) || games <= 0 || !Number.isFinite(wins)) return undefined;
  const z = 1.959964;
  const n = games;
  const p = Math.min(1, Math.max(0, wins / n));
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const lo = Math.max(0, (centre - spread) / denom);
  const hi = Math.min(1, (centre + spread) / denom);
  return Math.round(((hi - lo) / 2) * 1000) / 10;
}

export interface SampleFields {
  /** 95% confidence half-width in percentage points ("±x pp"). */
  win_rate_ci95_pp?: number;
  /** True when the sample is too small for precise win-rate claims. */
  low_sample?: boolean;
}

export function sampleFields(games: number, wins?: number): SampleFields {
  const out: SampleFields = {};
  const half = wilson95HalfWidthPp(games, wins ?? 0);
  if (half != null) out.win_rate_ci95_pp = half;
  if (games > 0 && games < LOW_SAMPLE_THRESHOLD) out.low_sample = true;
  return out;
}
