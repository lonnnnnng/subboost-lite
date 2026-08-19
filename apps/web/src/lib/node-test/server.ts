import type { ParsedNode } from "@subboost/core/types/node";
import { mapWithConcurrency, probeNodeTcp } from "./tcp";
import { testNodesWithMihomo } from "./mihomo";
import type { NodeTestMode, NodeTestRequestItem, NodeTestResult, ProxyProbeResult } from "./types";
import type { SpeedTestOptions } from "./mihomo";

const TCP_CONCURRENCY = 6;
const LATENCY_MIHOMO_WORKERS = 6;

function unavailableFromTcp(error: string | undefined): ProxyProbeResult {
  return { status: "unavailable", error: error || "节点地址无法用于代理测速" };
}

export type NodeTestOptions = SpeedTestOptions & {
  tcpTimeoutMs?: number;
  onResult?: (result: NodeTestResult) => void;
};

function splitAcrossWorkers<T>(items: readonly T[], workerCount: number): T[][] {
  const chunks = Array.from({ length: Math.min(Math.max(1, workerCount), items.length) }, () => [] as T[]);
  items.forEach((item, index) => chunks[index % chunks.length].push(item));
  return chunks;
}

export async function testNodeBatch(items: readonly NodeTestRequestItem[], mode: NodeTestMode, options: NodeTestOptions = {}): Promise<{
  results: NodeTestResult[];
  coreVersion?: string;
}> {
  const completedAt = new Map<string, string>();
  const emitResult = (item: NodeTestRequestItem, tcp: NodeTestResult["tcp"], proxy: ProxyProbeResult) => {
    const testedAt = new Date().toISOString();
    completedAt.set(item.key, testedAt);
    options.onResult?.({ key: item.key, tcp, proxy, testedAt });
  };

  // long: 连通性超时独立于下载采样窗口，用户可以快速筛除不可达节点而不缩短真实测速时间。
  const tcpResults = await mapWithConcurrency(items, TCP_CONCURRENCY, async (item) => {
    const tcp = await probeNodeTcp(item.node, {}, options.tcpTimeoutMs ?? 3500);
    if (!tcp.pinnedServer) emitResult(item, tcp, unavailableFromTcp(tcp.error));
    return tcp;
  });
  const mihomoItems = items.flatMap((item, index) => {
    const pinnedServer = tcpResults[index].pinnedServer;
    return pinnedServer ? [{ key: item.key, node: item.node, pinnedServer }] : [];
  });
  const tcpByKey = new Map(items.map((item, index) => [item.key, tcpResults[index]]));
  const itemByKey = new Map(items.map((item) => [item.key, item]));
  // long: 延迟测试使用多个独立 Mihomo 进程并行，每个进程只串行切换自己的组，既提高吞吐也不会把一个 worker 的出口串到另一个节点。
  const workerChunks = mode === "latency"
    ? splitAcrossWorkers(mihomoItems, LATENCY_MIHOMO_WORKERS)
    : (mihomoItems.length > 0 ? [mihomoItems] : []);
  const batches = await Promise.all(workerChunks.map(async (chunk) => await testNodesWithMihomo(chunk, mode, {
    durationMs: (options.durationMs ?? 15_000),
    concurrency: options.concurrency ?? 10,
    source: options.source,
    url: options.url,
    maxDataBytes: options.maxDataBytes,
    onProgress: options.onProgress,
    onResult: (key, proxy) => {
      const item = itemByKey.get(key);
      const tcp = tcpByKey.get(key);
      if (item && tcp) emitResult(item, tcp, proxy);
    },
  })));
  const mihomoResults = new Map<string, ProxyProbeResult>();
  for (const batch of batches) {
    for (const [key, result] of batch.results) mihomoResults.set(key, result);
  }

  return {
    coreVersion: batches.find((batch) => batch.version)?.version,
    results: items.map((item, index) => ({
      key: item.key,
      tcp: tcpResults[index],
      proxy: mihomoResults.get(item.key) ?? unavailableFromTcp(tcpResults[index].error),
      testedAt: completedAt.get(item.key) ?? new Date().toISOString(),
    })),
  };
}

export function isNodeTestRequestItem(value: unknown): value is NodeTestRequestItem {
  if (!value || typeof value !== "object") return false;
  const item = value as { key?: unknown; node?: unknown };
  if (typeof item.key !== "string" || !item.key.trim() || item.key.length > 200) return false;
  if (!item.node || typeof item.node !== "object" || Array.isArray(item.node)) return false;
  const node = item.node as Partial<ParsedNode>;
  return (
    typeof node.name === "string" && node.name.length > 0 && node.name.length <= 512 &&
    typeof node.type === "string" && node.type.length > 0 && node.type.length <= 64 &&
    typeof node.server === "string" && node.server.length > 0 && node.server.length <= 512 &&
    Number.isInteger(node.port) && Number(node.port) >= 1 && Number(node.port) <= 65535
  );
}
