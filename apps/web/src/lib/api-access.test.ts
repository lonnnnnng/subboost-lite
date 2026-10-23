import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedApiRequest } from "./api-access";

function request(host: string, origin?: string, extra: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3010/api/import", {
    headers: { Host: host, ...(origin === undefined ? {} : { Origin: origin }), ...extra },
  });
}

afterEach(() => vi.unstubAllEnvs());

describe("主动联网 API 入口", () => {
  it("默认保留本机同源和无 Origin 运维请求", () => {
    vi.stubEnv("SUBCONVERT_ALLOWED_ORIGINS", "");
    expect(isAllowedApiRequest(request("127.0.0.1:3010", "http://127.0.0.1:3010"))).toBe(true);
    expect(isAllowedApiRequest(request("localhost:3010"))).toBe(true);
    expect(isAllowedApiRequest(request("[::1]:3010", "http://[::1]:3010"))).toBe(true);
    expect(isAllowedApiRequest(request("192.168.1.2:9999", "http://192.168.1.2:9999"))).toBe(false);
  });

  it("显式允许局域网地址，不受 Next 内部 URL 改写影响", () => {
    vi.stubEnv("SUBCONVERT_ALLOWED_ORIGINS", "http://192.168.1.2:9999");
    expect(isAllowedApiRequest(request("192.168.1.2:9999", "http://192.168.1.2:9999"))).toBe(true);
    expect(isAllowedApiRequest(request("192.168.1.2:9999"))).toBe(true);
  });

  it.each(["http://evil.example", "https://192.168.1.2:9999", "http://192.168.1.2:9998", "null", "invalid", "http://192.168.1.2:9999/path", "http://user@192.168.1.2:9999"])("拒绝不同来源或无效 Origin: %s", (origin) => {
    vi.stubEnv("SUBCONVERT_ALLOWED_ORIGINS", "http://192.168.1.2:9999");
    expect(isAllowedApiRequest(request("192.168.1.2:9999", origin))).toBe(false);
  });

  it("伪造转发头不能放行未配置入口", () => {
    vi.stubEnv("SUBCONVERT_ALLOWED_ORIGINS", "http://192.168.1.2:9999");
    expect(isAllowedApiRequest(request("evil.example", undefined, { "x-forwarded-host": "127.0.0.1:3010" }))).toBe(false);
    expect(isAllowedApiRequest(request("127.0.0.1:3010", undefined, { "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isAllowedApiRequest(request("192.168.1.2:9999/evil"))).toBe(false);
  });
});
