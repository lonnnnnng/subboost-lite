import { describe, expect, it } from "vitest";
import { mihomoAssetPattern } from "./mihomo-platform";

describe("Mihomo 发布文件选择", () => {
  it.each([
    ["linux", "x64", "mihomo-linux-amd64-compatible-v1.19.33.gz"],
    ["linux", "arm64", "mihomo-linux-arm64-v1.19.33.gz"],
    ["darwin", "x64", "mihomo-darwin-amd64-v1.19.33.gz"],
    ["darwin", "arm64", "mihomo-darwin-arm64-v1.19.33.gz"],
  ])("匹配 %s/%s 的稳定发布文件", (platform, arch, asset) => {
    const pattern = mihomoAssetPattern(platform, arch);
    expect(pattern?.test(asset)).toBe(true);
    expect(pattern?.test(asset.replace(".gz", ".deb"))).toBe(false);
    expect(pattern?.test(asset.replace("-v1.19.33", "-go120-v1.19.33"))).toBe(false);
  });

  it("避免 Linux x64 误用高指令集或其他平台内核", () => {
    const pattern = mihomoAssetPattern("linux", "x64");
    expect(pattern?.test("mihomo-linux-amd64-v3-v1.19.33.gz")).toBe(false);
    expect(pattern?.test("mihomo-darwin-amd64-v1.19.33.gz")).toBe(false);
    expect(mihomoAssetPattern("win32", "x64")).toBeNull();
    expect(mihomoAssetPattern("linux", "arm")).toBeNull();
  });
});
