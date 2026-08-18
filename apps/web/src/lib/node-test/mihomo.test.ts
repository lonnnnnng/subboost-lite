import { describe, expect, it } from "vitest";
import { calculateDownloadSpeedMbps, calculatePercentile, calculateStabilityPercent } from "./speed-math";
import { buildSpeedTestTarget } from "./speed-target";

describe("calculateDownloadSpeedMbps", () => {
  it("按聚合字节数和实际耗时计算 Mbps", () => {
    expect(calculateDownloadSpeedMbps(75_000_000, 10)).toBe(60);
    expect(calculateDownloadSpeedMbps(7_500_000, 10)).toBe(6);
  });
});

describe("speed statistics", () => {
  it("calculates an interpolated P90 without mutating samples", () => {
    const samples = [10, 40, 20, 30];
    expect(calculatePercentile(samples, 0.9)).toBe(37);
    expect(samples).toEqual([10, 40, 20, 30]);
  });

  it("returns deterministic values for empty and single samples", () => {
    expect(calculatePercentile([], 0.9)).toBe(0);
    expect(calculateStabilityPercent([])).toBe(0);
    expect(calculateStabilityPercent([25])).toBe(100);
  });

  it("reduces stability when interval throughput fluctuates", () => {
    expect(calculateStabilityPercent([20, 20, 20])).toBe(100);
    expect(calculateStabilityPercent([10, 20, 30])).toBeLessThan(70);
  });
});

describe("buildSpeedTestTarget", () => {
  it("uses Cloudflare byte chunks", () => {
    const target = buildSpeedTestTarget("cloudflare", undefined, 0, 8_000_000);
    expect(target.url).toContain("https://speed.cloudflare.com/__down");
    expect(target.url).toContain("bytes=8000000");
    expect(target.headers.Range).toBeUndefined();
  });

  it("uses Range for GitHub and custom sources", () => {
    const github = buildSpeedTestTarget("github", undefined, 8_000_000, 4_000_000);
    const custom = buildSpeedTestTarget("custom", "https://example.com/test.bin", 0, 1_000_000);
    expect(github.headers.Range).toBe("bytes=8000000-11999999");
    expect(custom.url).toBe("https://example.com/test.bin");
    expect(custom.headers.Range).toBe("bytes=0-999999");
  });
});
