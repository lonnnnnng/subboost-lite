import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { resolveHostnameByDoh } from "@subboost/server-core/subscription/doh-resolver";
import {
  isPrivateOrReservedIp,
  normalizeResolvedIpAddresses,
  selectDnsAddressesAfterFakeIpRecheck,
  shouldRecheckFakeIpDnsAnswers,
} from "@subboost/server-core/subscription/ssrf-ip";

const DOH_TIMEOUT_MS = 4000;

export type PublicHostResolverDependencies = {
  lookupHost?: typeof lookup;
  resolveByDoh?: typeof resolveHostnameByDoh;
};

export class PublicHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicHostError";
  }
}

export function normalizePublicHostname(hostname: string): string {
  return hostname.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

export async function resolvePublicHost(
  hostname: string,
  dependencies: PublicHostResolverDependencies = {}
): Promise<string[]> {
  const normalized = normalizePublicHostname(hostname);
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) {
    throw new PublicHostError("禁止访问本机或内网地址");
  }
  if (isPrivateOrReservedIp(normalized)) {
    throw new PublicHostError("禁止访问本机或内网地址");
  }
  if (isIP(normalized)) return [normalized];

  const lookupHost = dependencies.lookupHost ?? lookup;
  const resolveByDoh = dependencies.resolveByDoh ?? resolveHostnameByDoh;
  const records = await lookupHost(normalized, { all: true, verbatim: true }).catch(() => null);
  if (!records || records.length === 0) {
    throw new PublicHostError("无法核验节点域名的公网地址");
  }

  const addresses = normalizeResolvedIpAddresses(records.map((record) => record.address));
  const finalAddresses = shouldRecheckFakeIpDnsAnswers(addresses)
    ? selectDnsAddressesAfterFakeIpRecheck(
        addresses,
        await resolveByDoh(normalized, { timeoutMs: DOH_TIMEOUT_MS })
      )
    : addresses;
  const addressesToCheck = finalAddresses.length > 0 ? finalAddresses : addresses;

  // long: 域名只要混入一个私网结果就整体拒绝，不能让攻击者利用多 A 记录把测速接口变成内网端口扫描器。
  if (addressesToCheck.some((address) => isPrivateOrReservedIp(address))) {
    throw new PublicHostError("禁止访问本机或内网地址");
  }
  if (addressesToCheck.length === 0) {
    throw new PublicHostError("无法核验节点域名的公网地址");
  }
  return addressesToCheck;
}
