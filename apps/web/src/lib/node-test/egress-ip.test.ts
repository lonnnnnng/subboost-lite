import { describe, expect, it } from "vitest";
import { parseEgressIpPayload } from "./egress-ip";

describe("parseEgressIpPayload", () => {
  it.each([
    [{ ip: "1.1.1.1", country_code: "sg" }, "SG"],
    [{ ip: "2001:4860:4860::8888", countryCode: "TW" }, "TW"],
    [{ query: "8.8.8.8", countryCode: "US" }, "US"],
    [{ ip: "9.9.9.9", cc: "de" }, "DE"],
    [{ ip: "8.8.4.4", country: "UK" }, "GB"],
  ])("支持 FlClash 使用的出口服务响应格式", (payload, countryCode) => {
    expect(parseEgressIpPayload(payload, "test")).toEqual({
      ip: String((payload as { ip?: string; query?: string }).ip ?? (payload as { query?: string }).query),
      countryCode,
      provider: "test",
    });
  });

  it.each([
    null,
    {},
    { ip: "not-an-ip", country_code: "SG" },
    { ip: "1.1.1.1", country_code: "Singapore" },
  ])("拒绝无效或不完整的响应：%j", (payload) => {
    expect(parseEgressIpPayload(payload, "test")).toBeNull();
  });
});
