import type { ParsedNode } from "@subboost/core/types/node";

export const MAX_SPEED_TEST_NODES = 5;

export type NodeTestMode = "latency" | "speed";

export type SpeedTestSource = "cloudflare" | "github" | "custom";

export type NodeTestRequestItem = {
  key: string;
  node: ParsedNode;
};

export type NodeTestRequest = {
  nodes: NodeTestRequestItem[];
  mode: NodeTestMode;
  durationSeconds?: number;
  speedConcurrency?: number;
  speedSource?: SpeedTestSource;
  speedUrl?: string;
  speedMaxDataMb?: number;
  tcpTimeoutSeconds?: number;
};

export type TcpProbeResult = {
  status: "reachable" | "unreachable" | "blocked";
  latencyMs?: number;
  pinnedServer?: string;
  error?: string;
};

export type ProxyProbeResult = {
  status: "available" | "unavailable" | "unsupported" | "core-unavailable";
  latencyMs?: number;
  downloadSpeedMbps?: number;
  downloadSampleBytes?: number;
  downloadTransferredBytes?: number;
  downloadComplete?: boolean;
  downloadPeakMbps?: number;
  downloadStabilityPercent?: number;
  downloadDurationSeconds?: number;
  downloadSource?: SpeedTestSource;
  downloadStopReason?: "duration" | "data-limit" | "stream-error";
  downloadFailedStreams?: number;
  downloadSampleCount?: number;
  egressIp?: string;
  egressCountryCode?: string;
  egressProvider?: string;
  egressError?: string;
  error?: string;
};

export type NodeTestResult = {
  key: string;
  tcp: TcpProbeResult;
  proxy: ProxyProbeResult;
  testedAt: string;
};

export type NodeTestApiResponse =
  | { ok: true; mode: NodeTestMode; results: NodeTestResult[]; coreVersion?: string }
  | { ok: false; error: string };
