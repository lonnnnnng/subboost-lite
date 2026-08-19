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

type CountryVote = {
  countryCode: string;
  results: EgressIpInfo[];
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

export function selectConsensusEgressIpInfo(results: readonly EgressIpInfo[]): EgressIpInfo | null {
  if (results.length === 0) return null;
  if (results.length === 1) return results[0];

  const votes = new Map<string, EgressIpInfo[]>();
  for (const result of results) {
    const countryResults = votes.get(result.countryCode) ?? [];
    countryResults.push(result);
    votes.set(result.countryCode, countryResults);
  }
  const ranked = [...votes.entries()]
    .map(([countryCode, countryResults]): CountryVote => ({ countryCode, results: countryResults }))
    .sort((left, right) => right.results.length - left.results.length || left.countryCode.localeCompare(right.countryCode));
  const winner = ranked[0];
  // long: 两个以上服务必须形成唯一多数；平票时不自动给节点标地区，避免 GeoIP 数据库分歧覆盖用户手动判断。
  if (!winner || winner.results.length === ranked[1]?.results.length) return null;

  const ipCounts = new Map<string, number>();
  for (const result of winner.results) ipCounts.set(result.ip, (ipCounts.get(result.ip) ?? 0) + 1);
  const selectedIp = [...ipCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
  if (!selectedIp) return null;
  return {
    ip: selectedIp,
    countryCode: winner.countryCode,
    provider: winner.results.map((result) => result.provider).join(" + "),
  };
}

export function selectAbsoluteMajorityEgressIpInfo(
  results: readonly EgressIpInfo[],
  totalSourceCount: number
): EgressIpInfo | null {
  const consensus = selectConsensusEgressIpInfo(results);
  if (!consensus) return null;
  const supportingCount = results.filter((result) => result.countryCode === consensus.countryCode).length;
  return supportingCount > totalSourceCount / 2 ? consensus : null;
}

export async function requestEgressIpInfo(mixedPort: number): Promise<EgressIpInfo> {
  const dispatcher = new ProxyAgent(`http://127.0.0.1:${mixedPort}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EGRESS_LOOKUP_TIMEOUT_MS);
  try {
    return await new Promise<EgressIpInfo>((resolve, reject) => {
      const results: EgressIpInfo[] = [];
      let settledCount = 0;
      let completed = false;
      const settle = () => {
        if (completed) return;
        // long: 七个来源中四个已一致时后续结果不可能推翻绝对多数，立即返回可避免每个节点都等待最慢服务超时。
        const majority = selectAbsoluteMajorityEgressIpInfo(results, IP_INFO_SOURCES.length);
        if (majority) {
          completed = true;
          resolve(majority);
          controller.abort();
          return;
        }
        if (settledCount < IP_INFO_SOURCES.length) return;
        completed = true;
        const consensus = selectConsensusEgressIpInfo(results);
        if (consensus) {
          resolve(consensus);
          return;
        }
        if (results.length > 0) {
          const summary = [...new Set(results.map((result) => result.countryCode))].sort().join(" / ");
          reject(new Error(`出口地区查询结果存在分歧：${summary}`));
          return;
        }
        reject(new Error("未能通过当前节点获取出口地区"));
      };

      for (const source of IP_INFO_SOURCES) {
        void querySource(source, dispatcher, controller.signal)
          .then((result) => results.push(result))
          .catch(() => undefined)
          .finally(() => {
            settledCount += 1;
            settle();
          });
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("出口地区查询结果存在分歧")) throw error;
    throw new Error("未能通过当前节点获取一致的出口地区");
  } finally {
    clearTimeout(timer);
    controller.abort();
    await dispatcher.close();
  }
}
