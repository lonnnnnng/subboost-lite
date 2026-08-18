import { NextResponse } from "next/server";
import { isNodeTestRequestItem, testNodeBatch } from "@/lib/node-test/server";
import { MAX_SPEED_TEST_NODES, type NodeTestApiResponse, type NodeTestMode, type NodeTestRequest, type SpeedTestSource } from "@/lib/node-test/types";

export const runtime = "nodejs";

function isLocalRequest(request: Request): boolean {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const requestHost = forwardedHost || request.headers.get("host") || new URL(request.url).host;
  let hostname: string;
  try {
    hostname = new URL(`http://${requestHost}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    // long: Next 开发服务器可能把 Request.url 改写为内部地址；同源判断以浏览器实际发送的 Host 为准。
    return new URL(origin).host === requestHost;
  } catch {
    return false;
  }
}

function json(body: NodeTestApiResponse, status = 200) {
  return NextResponse.json<NodeTestApiResponse>(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  // long: 节点探测具备主动联网和下载能力，只允许当前机器上的同源页面调用，避免接口被远程滥用。
  if (!isLocalRequest(request)) return json({ ok: false, error: "节点测试只允许从本机页面调用" }, 403);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "请求内容不是有效 JSON" }, 400);
  }

  const nodes = (body as { nodes?: unknown })?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return json({ ok: false, error: "请至少选择 1 个节点进行测试" }, 400);
  }
  if (!nodes.every(isNodeTestRequestItem)) {
    return json({ ok: false, error: "节点测试参数格式无效" }, 400);
  }
  const mode = (body as { mode?: unknown })?.mode;
  if (mode !== "latency" && mode !== "speed") {
    return json({ ok: false, error: "节点测试模式无效" }, 400);
  }
  // long: API 必须与页面采用相同边界，只有高带宽下载测速限制批量数量，连通/延迟探测不设节点上限。
  if (mode === "speed" && nodes.length > MAX_SPEED_TEST_NODES) {
    return json({ ok: false, error: `单次最多测速 ${MAX_SPEED_TEST_NODES} 个节点，请分批选择` }, 400);
  }
  const durationSeconds = (body as { durationSeconds?: unknown })?.durationSeconds;
  if (mode === "speed" && (durationSeconds === undefined || !Number.isInteger(durationSeconds) || Number(durationSeconds) < 15 || Number(durationSeconds) > 300)) {
    return json({ ok: false, error: "测速时长必须是 15-300 秒的整数" }, 400);
  }
  const speedConcurrency = (body as { speedConcurrency?: unknown })?.speedConcurrency;
  if (mode === "speed" && (
    speedConcurrency === undefined ||
    !Number.isInteger(speedConcurrency) ||
    Number(speedConcurrency) < 1 ||
    Number(speedConcurrency) > 20
  )) {
    return json({ ok: false, error: "测速并发数必须是 1-20 的整数" }, 400);
  }
  const speedSource = (body as { speedSource?: unknown })?.speedSource;
  if (mode === "speed" && speedSource !== "cloudflare" && speedSource !== "github" && speedSource !== "custom") {
    return json({ ok: false, error: "测速来源无效" }, 400);
  }
  const speedUrl = (body as { speedUrl?: unknown })?.speedUrl;
  if (mode === "speed" && speedSource === "custom") {
    if (typeof speedUrl !== "string" || speedUrl.length > 2048) return json({ ok: false, error: "自定义测速地址无效" }, 400);
    try {
      const parsed = new URL(speedUrl);
      if (parsed.protocol !== "https:") throw new Error("protocol");
    } catch {
      return json({ ok: false, error: "自定义测速地址必须是 HTTPS URL" }, 400);
    }
  }
  const speedMaxDataMb = (body as { speedMaxDataMb?: unknown })?.speedMaxDataMb;
  if (mode === "speed" && (
    speedMaxDataMb === undefined ||
    !Number.isInteger(speedMaxDataMb) ||
    Number(speedMaxDataMb) < 50 ||
    Number(speedMaxDataMb) > 2048
  )) {
    return json({ ok: false, error: "测速采样上限必须是 50-2048 MB 的整数" }, 400);
  }
  const tcpTimeoutSeconds = (body as { tcpTimeoutSeconds?: unknown })?.tcpTimeoutSeconds;
  if (tcpTimeoutSeconds !== undefined && (
    typeof tcpTimeoutSeconds !== "number" ||
    !Number.isFinite(tcpTimeoutSeconds) ||
    tcpTimeoutSeconds < 1 ||
    tcpTimeoutSeconds > 30
  )) {
    return json({ ok: false, error: "连通性超时必须是 1-30 秒的数字" }, 400);
  }

  try {
    const request = body as NodeTestRequest;
    // long: API 以秒接收便于页面编辑，进入 socket 层前统一转换为整数毫秒，避免不同调用方解释不一致。
    const tcpTimeoutMs = Math.round(Number(tcpTimeoutSeconds ?? 3.5) * 1000);
    const result = await testNodeBatch(request.nodes, mode as NodeTestMode, {
      tcpTimeoutMs,
      ...(mode === "speed" ? {
        durationMs: Number(durationSeconds) * 1000,
        concurrency: Number(speedConcurrency),
        source: speedSource as SpeedTestSource,
        url: typeof speedUrl === "string" ? speedUrl : undefined,
        maxDataBytes: Number(speedMaxDataMb) * 1_000_000,
      } : {}),
    });
    return json({ ok: true, mode: mode as NodeTestMode, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "节点测试失败";
    return json({ ok: false, error: message }, 500);
  }
}
