export function mihomoAssetPattern(platform: string, arch: string): RegExp | null {
  if (platform === "darwin" && arch === "arm64") return /^mihomo-darwin-arm64-v\d+\.\d+\.\d+\.gz$/;
  if (platform === "darwin" && arch === "x64") return /^mihomo-darwin-amd64-v\d+\.\d+\.\d+\.gz$/;
  // long: Linux x64 优先使用 compatible 构建，避免老服务器因 CPU 指令集不足而启动失败。
  if (platform === "linux" && arch === "x64") return /^mihomo-linux-amd64-compatible-v\d+\.\d+\.\d+\.gz$/;
  if (platform === "linux" && arch === "arm64") return /^mihomo-linux-arm64-v\d+\.\d+\.\d+\.gz$/;
  return null;
}
