export function calculateDownloadSpeedMbps(bytes: number, seconds: number): number {
  return Math.round((bytes * 8 / Math.max(0.001, seconds) / 1_000_000) * 10) / 10;
}

export function calculatePercentile(values: readonly number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, (sorted.length - 1) * percentile));
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const value = sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
  return Math.round(value * 10) / 10;
}

export function calculateStabilityPercent(values: readonly number[]): number {
  const valid = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (valid.length <= 1) return valid.length === 1 ? 100 : 0;
  const mean = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  if (mean <= 0) return 0;
  const variance = valid.reduce((sum, value) => sum + (value - mean) ** 2, 0) / valid.length;
  return Math.round(Math.max(0, Math.min(100, 100 - (Math.sqrt(variance) / mean) * 100)) * 10) / 10;
}
