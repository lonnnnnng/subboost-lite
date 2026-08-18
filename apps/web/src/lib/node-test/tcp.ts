import { createConnection, isIP, type Socket } from "node:net";
import type { ParsedNode } from "@subboost/core/types/node";
import { resolvePublicHost } from "../public-host";
import type { TcpProbeResult } from "./types";

const DEFAULT_TCP_TIMEOUT_MS = 3500;

export type TcpProbeDependencies = {
  resolveHost?: typeof resolvePublicHost;
  connect?: (options: { host: string; port: number; family: 4 | 6 }) => Socket;
  now?: () => number;
};

function publicProbeError(error: unknown): string {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (code === "ECONNREFUSED") return "连接被拒绝";
  if (code === "ETIMEDOUT") return "连接超时";
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH") return "网络不可达";
  return "无法建立 TCP 连接";
}

async function connectAddress(
  address: string,
  port: number,
  timeoutMs: number,
  dependencies: TcpProbeDependencies
): Promise<number> {
  const now = dependencies.now ?? Date.now;
  const connect = dependencies.connect ?? ((options) => createConnection(options));
  const startedAt = now();

  return await new Promise<number>((resolve, reject) => {
    const socket = connect({ host: address, port, family: isIP(address) === 6 ? 6 : 4 });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback();
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(() => resolve(Math.max(1, Math.round(now() - startedAt)))));
    socket.once("timeout", () => finish(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))));
    socket.once("error", (error) => finish(() => reject(error)));
  });
}

export async function probeNodeTcp(
  node: ParsedNode,
  dependencies: TcpProbeDependencies = {},
  timeoutMs = DEFAULT_TCP_TIMEOUT_MS
): Promise<TcpProbeResult> {
  const server = typeof node.server === "string" ? node.server.trim() : "";
  const port = Number(node.port);
  if (!server || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { status: "unreachable", error: "节点服务器或端口无效" };
  }

  let addresses: string[];
  try {
    addresses = await (dependencies.resolveHost ?? resolvePublicHost)(server);
  } catch (error) {
    return { status: "blocked", error: error instanceof Error ? error.message : "节点地址安全校验失败" };
  }

  let lastError: unknown;
  for (const address of addresses) {
    try {
      const latencyMs = await connectAddress(address, port, timeoutMs, dependencies);
      return { status: "reachable", latencyMs, pinnedServer: address };
    } catch (error) {
      lastError = error;
    }
  }
  return { status: "unreachable", pinnedServer: addresses[0], error: publicProbeError(lastError) };
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, run));
  return results;
}
