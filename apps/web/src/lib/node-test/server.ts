import type { ParsedNode } from "@subboost/core/types/node";
import { mapWithConcurrency, probeNodeTcp } from "./tcp";
import { testNodesWithMihomo } from "./mihomo";
import type { NodeTestMode, NodeTestRequestItem, NodeTestResult, ProxyProbeResult } from "./types";
import type { SpeedTestOptions } from "./mihomo";

const TCP_CONCURRENCY = 6;

function unavailableFromTcp(error: string | undefined): ProxyProbeResult {
  return { status: "unavailable", error: error || "节点地址无法用于代理测速" };
}

export type NodeTestOptions = SpeedTestOptions & { tcpTimeoutMs?: number };

export async function testNodeBatch(items: readonly NodeTestRequestItem[], mode: NodeTestMode, options: NodeTestOptions = {}): Promise<{
  results: NodeTestResult[];
  coreVersion?: string;
}> {
  // long: 连通性超时独立于下载采样窗口，用户可以快速筛除不可达节点而不缩短真实测速时间。
  const tcpResults = await mapWithConcurrency(items, TCP_CONCURRENCY, async (item) => await probeNodeTcp(item.node, {}, options.tcpTimeoutMs ?? 3500));
  const mihomoItems = items.flatMap((item, index) => {
    const pinnedServer = tcpResults[index].pinnedServer;
    return pinnedServer ? [{ key: item.key, node: item.node, pinnedServer }] : [];
  });
  const mihomo = await testNodesWithMihomo(mihomoItems, mode, {
    durationMs: (options.durationMs ?? 15_000),
    concurrency: options.concurrency ?? 4,
    source: options.source,
    url: options.url,
    maxDataBytes: options.maxDataBytes,
  });
  const testedAt = new Date().toISOString();

  return {
    coreVersion: mihomo.version,
    results: items.map((item, index) => ({
      key: item.key,
      tcp: tcpResults[index],
      proxy: mihomo.results.get(item.key) ?? unavailableFromTcp(tcpResults[index].error),
      testedAt,
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
