import type { SpeedTestSource } from "./types";

export const DEFAULT_GITHUB_SPEED_TEST_URL = "https://github.com/ollama/ollama/releases/download/v0.32.14/ollama-linux-arm64-jetpack5.tar.zst";
export const CLOUDFLARE_SPEED_TEST_URL = "https://speed.cloudflare.com/__down";

export function buildSpeedTestTarget(source: SpeedTestSource, url: string | undefined, offset: number, chunkBytes: number): { url: string; headers: Record<string, string> } {
  if (source === "cloudflare") {
    const target = new URL(url || CLOUDFLARE_SPEED_TEST_URL);
    target.searchParams.set("bytes", String(chunkBytes));
    return {
      url: target.toString(),
      headers: { "Accept-Encoding": "identity", "User-Agent": "SubConvert-Lite-Speed-Test" },
    };
  }
  return {
    url: url || DEFAULT_GITHUB_SPEED_TEST_URL,
    headers: {
      "Accept-Encoding": "identity",
      Range: `bytes=${offset}-${offset + chunkBytes - 1}`,
      "User-Agent": "SubConvert-Lite-Speed-Test",
    },
  };
}
