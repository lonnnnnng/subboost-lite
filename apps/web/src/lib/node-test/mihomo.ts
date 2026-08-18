import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { dump } from "js-yaml";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import {
  isMihomoSupportedProxyNode,
  sanitizeMihomoProxyNode,
} from "@subboost/core/mihomo/proxy-sanitizer";
import type { ParsedNode } from "@subboost/core/types/node";
import type { NodeTestMode, ProxyProbeResult, SpeedTestSource } from "./types";
import { calculateDownloadSpeedMbps, calculateStabilityPercent } from "./speed-math";
import { requestEgressIpInfo } from "./egress-ip";
import { buildSpeedTestTarget } from "./speed-target";

const RELEASE_API = "https://api.github.com/repos/MetaCubeX/mihomo/releases/latest";
const BINARY_MAX_BYTES = 40 * 1024 * 1024;
const DEFAULT_SPEED_TEST_MAX_DATA_BYTES = 300 * 1_000_000;
const MIN_SPEED_SAMPLE_BYTES = 1_000_000;
const DEFAULT_SPEED_TEST_DURATION_MS = 15_000;
const DEFAULT_SPEED_TEST_CONCURRENCY = 10;
const DEFAULT_SPEED_TEST_SOURCE: SpeedTestSource = "cloudflare";
const SPEED_TEST_CHUNK_BYTES = 8 * 1_000_000;
const SPEED_TEST_WARMUP_MS = 1_500;
const SPEED_SAMPLE_INTERVAL_MS = 1_000;
const DELAY_TEST_URL = "https://www.gstatic.com/generate_204";

type ReleaseAsset = {
  name?: string;
  size?: number;
  digest?: string | null;
  browser_download_url?: string;
};

type ReleaseInfo = {
  tag_name?: string;
  assets?: ReleaseAsset[];
};

type MihomoBinary = {
  path: string;
  version: string;
};

export type MihomoTestItem = {
  key: string;
  node: ParsedNode;
  pinnedServer: string;
};

export type MihomoBatchResult = {
  version?: string;
  results: Map<string, ProxyProbeResult>;
};

let binaryPromise: Promise<MihomoBinary> | null = null;

function binaryDirectory(): string {
  if (process.env.SUBCONVERT_MIHOMO_DIR?.trim()) return process.env.SUBCONVERT_MIHOMO_DIR.trim();
  // long: npm workspace 会把 Next 的 cwd 设为 apps/web；只有从仓库根目录运行时才需要补 apps/web 前缀。
  return process.cwd().endsWith(join("apps", "web"))
    ? join(process.cwd(), "data/mihomo")
    : join(process.cwd(), "apps/web/data/mihomo");
}

function assetPattern(): RegExp | null {
  if (process.platform !== "darwin") return null;
  if (process.arch === "arm64") return /^mihomo-darwin-arm64-v\d+\.\d+\.\d+\.gz$/;
  if (process.arch === "x64") return /^mihomo-darwin-amd64-v\d+\.\d+\.\d+\.gz$/;
  return null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function downloadMihomoBinary(): Promise<MihomoBinary> {
  const explicitPath = process.env.SUBCONVERT_MIHOMO_PATH?.trim();
  if (explicitPath) {
    if (!await fileExists(explicitPath)) throw new Error("SUBCONVERT_MIHOMO_PATH 指向的文件不存在");
    return { path: explicitPath, version: "external" };
  }

  const directory = binaryDirectory();
  const binaryPath = join(directory, "mihomo");
  const metadataPath = join(directory, "metadata.json");
  if (await fileExists(binaryPath)) {
    let version = "cached";
    try {
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { version?: string };
      if (metadata.version) version = metadata.version;
    } catch {
      // long: 元数据损坏不会影响已经校验并落盘的内核继续使用。
    }
    return { path: binaryPath, version };
  }

  const pattern = assetPattern();
  if (!pattern) throw new Error("当前系统架构暂不支持自动准备 Mihomo 内核");

  const releaseResponse = await fetch(RELEASE_API, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "SubConvert-Lite" },
    cache: "no-store",
  });
  if (!releaseResponse.ok) throw new Error(`获取 Mihomo 发布信息失败：HTTP ${releaseResponse.status}`);
  const release = await releaseResponse.json() as ReleaseInfo;
  const asset = release.assets?.find((item) => typeof item.name === "string" && pattern.test(item.name));
  if (!asset?.browser_download_url || !asset.name) throw new Error("未找到适用于当前 Mac 的 Mihomo 内核");
  if (!asset.size || asset.size > BINARY_MAX_BYTES) throw new Error("Mihomo 内核文件大小异常");

  const archiveResponse = await fetch(asset.browser_download_url, {
    headers: { Accept: "application/octet-stream", "User-Agent": "SubConvert-Lite" },
    cache: "no-store",
  });
  if (!archiveResponse.ok) throw new Error(`下载 Mihomo 内核失败：HTTP ${archiveResponse.status}`);
  const compressed = Buffer.from(await archiveResponse.arrayBuffer());
  if (compressed.byteLength > BINARY_MAX_BYTES) throw new Error("Mihomo 内核下载内容超过限制");

  const expectedDigest = asset.digest?.startsWith("sha256:") ? asset.digest.slice("sha256:".length) : "";
  if (!expectedDigest) throw new Error("Mihomo 发布文件缺少 SHA-256，已拒绝执行");
  const actualDigest = createHash("sha256").update(compressed).digest("hex");
  if (actualDigest !== expectedDigest) throw new Error("Mihomo 内核 SHA-256 校验失败");

  const executable = gunzipSync(compressed);
  const temporaryPath = join(directory, `mihomo-${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, executable, { mode: 0o755 });
    await chmod(temporaryPath, 0o755);
    await rename(temporaryPath, binaryPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  const version = release.tag_name || "latest";
  await writeFile(metadataPath, `${JSON.stringify({ version, asset: asset.name, digest: asset.digest }, null, 2)}\n`, "utf8");
  return { path: binaryPath, version };
}

export async function ensureMihomoBinary(): Promise<MihomoBinary> {
  binaryPromise ??= downloadMihomoBinary().catch((error) => {
    binaryPromise = null;
    throw error;
  });
  return await binaryPromise;
}

async function availablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function stripPrivateFields(node: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(node).filter(([key, value]) => !key.startsWith("_") && value !== undefined));
}

function pinNode(item: MihomoTestItem, internalName: string): Record<string, unknown> {
  const originalServer = String(item.node.server || "").trim();
  const node = stripPrivateFields(sanitizeMihomoProxyNode({ ...item.node, name: internalName }));
  node.server = item.pinnedServer;

  // long: Mihomo 只连接安全校验后的固定 IP，同时补回原域名作为 TLS SNI，兼顾 DNS rebinding 防护和证书握手。
  if (originalServer && originalServer !== item.pinnedServer) {
    const type = String(node.type || "");
    if ((type === "vmess" || type === "vless") && !node.servername && !node.sni) node.servername = originalServer;
    if (["trojan", "anytls", "hysteria", "hysteria2", "tuic"].includes(type) && !node.sni && !node.servername) {
      node.sni = originalServer;
    }
  }
  return node;
}

async function waitForController(baseUrl: string, secret: string, processHandle: ChildProcess): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (processHandle.exitCode !== null) throw new Error("Mihomo 启动失败");
    try {
      const response = await fetch(`${baseUrl}/version`, {
        headers: { Authorization: `Bearer ${secret}` },
        cache: "no-store",
      });
      if (response.ok) {
        const body = await response.json() as { version?: string };
        return body.version || "unknown";
      }
    } catch {
      // long: 内核启动和控制端口监听存在短暂间隔，限定十秒内重试，不把正常启动过程报告成失败。
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("等待 Mihomo 控制端口超时");
}

async function requestDelay(baseUrl: string, secret: string, proxyName: string): Promise<number> {
  const url = new URL(`${baseUrl}/proxies/${encodeURIComponent(proxyName)}/delay`);
  url.searchParams.set("timeout", "6000");
  url.searchParams.set("url", DELAY_TEST_URL);
  url.searchParams.set("expected", "200/204");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${secret}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`代理延迟测试失败：HTTP ${response.status}`);
  const body = await response.json() as { delay?: number };
  if (!Number.isFinite(body.delay) || Number(body.delay) <= 0) throw new Error("Mihomo 未返回有效延迟");
  return Math.round(Number(body.delay));
}

async function selectProxy(baseUrl: string, secret: string, groupName: string, proxyName: string): Promise<void> {
  const response = await fetch(`${baseUrl}/proxies/${encodeURIComponent(groupName)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: proxyName }),
  });
  if (!response.ok && response.status !== 204) throw new Error(`切换测速节点失败：HTTP ${response.status}`);
}

export type SpeedTestOptions = {
  durationMs?: number;
  concurrency?: number;
  source?: SpeedTestSource;
  url?: string;
  maxDataBytes?: number;
  onProgress?: (progress: DownloadProgress) => void;
};

export type DownloadProgress = {
  key?: string;
  currentMbps: number;
  peakMbps: number;
  sampleBytes: number;
  transferredBytes: number;
  durationSeconds: number;
};

export type DownloadSpeedResult = {
  speedMbps: number;
  sampleBytes: number;
  transferredBytes: number;
  complete: boolean;
  peakMbps: number;
  stabilityPercent: number;
  durationSeconds: number;
  source: SpeedTestSource;
  stopReason: "duration" | "data-limit" | "stream-error";
  failedStreams: number;
  sampleCount: number;
};

async function requestDownloadSpeed(mixedPort: number, options: SpeedTestOptions = {}): Promise<DownloadSpeedResult> {
  const durationMs = Math.min(300_000, Math.max(15_000, Math.round(options.durationMs ?? DEFAULT_SPEED_TEST_DURATION_MS)));
  const concurrency = Math.min(100, Math.max(1, Math.round(options.concurrency ?? DEFAULT_SPEED_TEST_CONCURRENCY)));
  const source = options.source ?? DEFAULT_SPEED_TEST_SOURCE;
  const maxDataBytes = Math.max(MIN_SPEED_SAMPLE_BYTES, Math.round(options.maxDataBytes ?? DEFAULT_SPEED_TEST_MAX_DATA_BYTES));
  const dispatcher = new ProxyAgent(`http://127.0.0.1:${mixedPort}`);
  const controller = new AbortController();
  const startedAt = performance.now();
  const warmupEndsAt = startedAt + SPEED_TEST_WARMUP_MS;
  let totalBytes = 0;
  let warmupBytes = 0;
  let warmupCaptured = false;
  let stoppedByDataLimit = false;
  const intervalSamples: number[] = [];
  let peakMbps = 0;
  let sampleBytesAt = 0;
  let sampleAt = 0;
  const sampleTimer = setInterval(() => {
    const now = performance.now();
    if (now < warmupEndsAt) return;
    if (!warmupCaptured) {
      warmupCaptured = true;
      warmupBytes = totalBytes;
      sampleBytesAt = totalBytes;
      sampleAt = now;
      return;
    }
    const seconds = Math.max(0.001, (now - sampleAt) / 1000);
    const currentMbps = calculateDownloadSpeedMbps(totalBytes - sampleBytesAt, seconds);
    intervalSamples.push(currentMbps);
    peakMbps = Math.max(peakMbps, currentMbps);
    options.onProgress?.({
      currentMbps,
      peakMbps,
      sampleBytes: Math.max(0, totalBytes - warmupBytes),
      transferredBytes: totalBytes,
      durationSeconds: Math.max(0, (now - warmupEndsAt) / 1000),
    });
    sampleBytesAt = totalBytes;
    sampleAt = now;
  }, SPEED_SAMPLE_INTERVAL_MS);
  const timer = setTimeout(() => controller.abort(), durationMs);
  let failedStreams = 0;
  try {
    // long: 每条连接循环请求分块，预热阶段只建立连接不计入主速度，避免单个大文件把高速节点提前“测完”。
    await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
      let offset = index * SPEED_TEST_CHUNK_BYTES;
      try {
        while (!controller.signal.aborted && (!warmupCaptured || totalBytes - warmupBytes < maxDataBytes)) {
          const remaining = warmupCaptured ? maxDataBytes - (totalBytes - warmupBytes) : SPEED_TEST_CHUNK_BYTES;
          const chunkBytes = Math.min(SPEED_TEST_CHUNK_BYTES, remaining);
          const target = buildSpeedTestTarget(source, options.url, offset, chunkBytes);
          const response = await undiciFetch(target.url, {
            dispatcher,
            signal: controller.signal,
            headers: target.headers,
          });
          if (!response.ok || !response.body) throw new Error(`下载测速失败：HTTP ${response.status}`);
          let chunkRead = 0;
          for await (const chunk of response.body) {
            if (controller.signal.aborted) break;
            const sampleRemaining = warmupCaptured ? maxDataBytes - (totalBytes - warmupBytes) : chunkBytes - chunkRead;
            const accepted = Math.min(chunk.byteLength, chunkBytes - chunkRead, sampleRemaining);
            if (accepted <= 0) break;
            if (!warmupCaptured && performance.now() >= warmupEndsAt) {
              warmupCaptured = true;
              warmupBytes = totalBytes;
              sampleBytesAt = totalBytes;
              sampleAt = performance.now();
            }
            totalBytes += accepted;
            chunkRead += accepted;
            if (warmupCaptured && totalBytes - warmupBytes >= maxDataBytes) {
              stoppedByDataLimit = true;
              controller.abort();
              break;
            }
            if (chunkRead >= chunkBytes) break;
          }
          offset += chunkRead;
          if (chunkRead <= 0) throw new Error("下载测速未返回有效数据");
        }
      } catch {
        if (!controller.signal.aborted) failedStreams += 1;
      }
    }));
    const endedAt = performance.now();
    if (!warmupCaptured) {
      warmupCaptured = true;
      warmupBytes = totalBytes;
    }
    const sampleBytes = Math.max(0, totalBytes - warmupBytes);
    const sampleSeconds = Math.max(0.001, (endedAt - Math.min(endedAt, warmupEndsAt)) / 1000);
    if (sampleBytes < MIN_SPEED_SAMPLE_BYTES) {
      throw new Error("下载测速返回的数据量不足");
    }
    if (warmupCaptured && sampleAt > 0 && endedAt > sampleAt && totalBytes > sampleBytesAt) {
      const currentMbps = calculateDownloadSpeedMbps(totalBytes - sampleBytesAt, (endedAt - sampleAt) / 1000);
      intervalSamples.push(currentMbps);
      peakMbps = Math.max(peakMbps, currentMbps);
      options.onProgress?.({
        currentMbps,
        peakMbps,
        sampleBytes,
        transferredBytes: totalBytes,
        durationSeconds: sampleSeconds,
      });
    }
    const stopReason = failedStreams > 0
      ? "stream-error"
      : stoppedByDataLimit ? "data-limit" : "duration";
    return {
      speedMbps: calculateDownloadSpeedMbps(sampleBytes, sampleSeconds),
      sampleBytes,
      transferredBytes: totalBytes,
      complete: stopReason === "data-limit",
      peakMbps,
      stabilityPercent: calculateStabilityPercent(intervalSamples),
      durationSeconds: Math.round(sampleSeconds * 10) / 10,
      source,
      stopReason,
      failedStreams,
      sampleCount: intervalSamples.length,
    };
  } finally {
    clearTimeout(timer);
    clearInterval(sampleTimer);
    await dispatcher.close();
  }
}

function publicProxyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort/i.test(message)) return "代理测速超时";
  if (/HTTP \d+/.test(message)) return message;
  return message || "代理节点不可用";
}

async function egressProbeFields(mixedPort: number): Promise<Pick<ProxyProbeResult, "egressIp" | "egressCountryCode" | "egressProvider" | "egressError">> {
  try {
    const result = await requestEgressIpInfo(mixedPort);
    return {
      egressIp: result.ip,
      egressCountryCode: result.countryCode,
      egressProvider: result.provider,
    };
  } catch (error) {
    return { egressError: error instanceof Error ? error.message : "出口地区查询失败" };
  }
}

export async function testNodesWithMihomo(
  items: readonly MihomoTestItem[],
  mode: NodeTestMode,
  speedOptions: SpeedTestOptions = {}
): Promise<MihomoBatchResult> {
  const results = new Map<string, ProxyProbeResult>();
  const supported = items.filter((item) => {
    if (isMihomoSupportedProxyNode(item.node)) return true;
    results.set(item.key, { status: "unsupported", error: `Mihomo 不支持 ${String(item.node.type)} 节点` });
    return false;
  });
  if (supported.length === 0) return { results };

  let binary: MihomoBinary;
  try {
    binary = await ensureMihomoBinary();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Mihomo 内核不可用";
    for (const item of supported) results.set(item.key, { status: "core-unavailable", error: message });
    return { results };
  }

  const workDirectory = await mkdtemp(join(tmpdir(), "subconvert-mihomo-"));
  const mixedPort = await availablePort();
  const controllerPort = await availablePort();
  const secret = randomUUID();
  const groupName = "SUBCONVERT_TEST";
  const internalNames = new Map(supported.map((item, index) => [item.key, `NODE_${String(index + 1).padStart(3, "0")}`]));
  const proxies = supported.map((item) => pinNode(item, internalNames.get(item.key)!));
  const config = {
    "mixed-port": mixedPort,
    "external-controller": `127.0.0.1:${controllerPort}`,
    secret,
    "allow-lan": false,
    "bind-address": "127.0.0.1",
    mode: "global",
    "log-level": "silent",
    ipv6: true,
    "unified-delay": true,
    "tcp-concurrent": true,
    proxies,
    "proxy-groups": [{ name: groupName, type: "select", proxies: [...internalNames.values()] }],
    rules: [`MATCH,${groupName}`],
  };
  const configPath = join(workDirectory, "config.yaml");
  await writeFile(configPath, dump(config, { noRefs: true, lineWidth: 140, forceQuotes: true }), "utf8");

  const processHandle = spawn(binary.path, ["-d", workDirectory, "-f", configPath], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  const baseUrl = `http://127.0.0.1:${controllerPort}`;
  let runtimeVersion = binary.version;
  try {
    runtimeVersion = await waitForController(baseUrl, secret, processHandle);
    for (const item of supported) {
      const proxyName = internalNames.get(item.key)!;
      try {
        // long: 出口查询必须先切换 select 组，否则多个节点会错误复用首个节点的实际出口。
        await selectProxy(baseUrl, secret, groupName, proxyName);
        const egress = await egressProbeFields(mixedPort);
        if (mode === "latency") {
          const latencyMs = await requestDelay(baseUrl, secret, proxyName);
          results.set(item.key, { status: "available", latencyMs, ...egress });
        } else {
          const download = await requestDownloadSpeed(mixedPort, {
            ...speedOptions,
            onProgress: (progress) => {
              speedOptions.onProgress?.({ ...progress, key: item.key });
            },
          });
          results.set(item.key, {
            status: "available",
            ...egress,
            downloadSpeedMbps: download.speedMbps,
            downloadSampleBytes: download.sampleBytes,
            downloadTransferredBytes: download.transferredBytes,
            downloadComplete: download.complete,
            downloadPeakMbps: download.peakMbps,
            downloadStabilityPercent: download.stabilityPercent,
            downloadDurationSeconds: download.durationSeconds,
            downloadSource: download.source,
            downloadStopReason: download.stopReason,
            downloadFailedStreams: download.failedStreams,
            downloadSampleCount: download.sampleCount,
            ...(download.stopReason === "duration" ? { error: `测速窗口结束，已按 ${Math.round(download.sampleBytes / 1_000_000)} MB 稳态样本计算平均速度` } : {}),
          });
        }
      } catch (error) {
        results.set(item.key, { status: "unavailable", error: publicProxyError(error) });
      }
    }
  } catch (error) {
    const message = publicProxyError(error);
    for (const item of supported) {
      if (!results.has(item.key)) results.set(item.key, { status: "core-unavailable", error: message });
    }
  } finally {
    processHandle.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (processHandle.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        processHandle.kill("SIGKILL");
        resolve();
      }, 1500);
      processHandle.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await rm(workDirectory, { recursive: true, force: true });
  }
  return { version: runtimeVersion, results };
}
