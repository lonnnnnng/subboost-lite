import { isIP } from "node:net";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const EGRESS_LOOKUP_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_CHARS = 64 * 1024;

type IpInfoSource = {
  id: string;
  url: string;
};

const IP_INFO_SOURCES: readonly IpInfoSource[] = [
  { id: "ipwho.is", url: "https://ipwho.is" },
  { id: "api.myip.com", url: "https://api.myip.com" },
  { id: "ipapi.co", url: "https://ipapi.co/json" },
  { id: "ident.me", url: "https://ident.me/json" },
  { id: "ip-api.com", url: "http://ip-api.com/json" },
  { id: "api.ip.sb", url: "https://api.ip.sb/geoip" },
  { id: "ipinfo.io", url: "https://ipinfo.io/json" },
];

export type EgressIpInfo = {
  ip: string;
  countryCode: string;
  provider: string;
};

function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function parseEgressIpPayload(payload: unknown, provider: string): EgressIpInfo | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const ip = firstString(record, ["ip", "query"]);
  const rawCountryCode = firstString(record, ["country_code", "countryCode", "cc", "country"]).toUpperCase();
  const countryCode = rawCountryCode === "UK" ? "GB" : rawCountryCode;
  if (isIP(ip) === 0 || !/^[A-Z]{2}$/.test(countryCode)) return null;
  return { ip, countryCode, provider };
}

async function querySource(source: IpInfoSource, dispatcher: ProxyAgent, signal: AbortSignal): Promise<EgressIpInfo> {
  const response = await undiciFetch(source.url, {
    dispatcher,
    signal,
    headers: { Accept: "application/json", "User-Agent": "SubConvert-Lite-Egress/1.0" },
  });
  if (!response.ok) throw new Error(`${source.id} HTTP ${response.status}`);
  const text = await response.text();
  if (!text || text.length > MAX_RESPONSE_CHARS) throw new Error(`${source.id} 返回内容大小异常`);
  const result = parseEgressIpPayload(JSON.parse(text) as unknown, source.id);
  if (!result) throw new Error(`${source.id} 未返回有效出口信息`);
  return result;
}

export async function requestEgressIpInfo(mixedPort: number): Promise<EgressIpInfo> {
  const dispatcher = new ProxyAgent(`http://127.0.0.1:${mixedPort}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EGRESS_LOOKUP_TIMEOUT_MS);
  try {
    // long: 与 FlClash 一致并发请求多个固定出口服务，取首个合法结果，避免单一 GeoIP 服务故障阻塞节点测试。
    const result = await Promise.any(IP_INFO_SOURCES.map((source) => querySource(source, dispatcher, controller.signal)));
    controller.abort();
    return result;
  } catch {
    throw new Error("未能通过当前节点获取出口地区");
  } finally {
    clearTimeout(timer);
    controller.abort();
    await dispatcher.close();
  }
}
