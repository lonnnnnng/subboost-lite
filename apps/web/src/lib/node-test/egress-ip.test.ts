import { describe, expect, it } from "vitest";
import { parseEgressIpPayload, selectAbsoluteMajorityEgressIpInfo, selectConsensusEgressIpInfo } from "./egress-ip";

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

describe("selectConsensusEgressIpInfo", () => {
  it("采用多个服务形成的唯一多数结果", () => {
    expect(selectConsensusEgressIpInfo([
      { ip: "1.1.1.1", countryCode: "SG", provider: "a" },
      { ip: "1.1.1.1", countryCode: "SG", provider: "b" },
      { ip: "2.2.2.2", countryCode: "TW", provider: "c" },
    ])).toEqual({
      ip: "1.1.1.1",
      countryCode: "SG",
      provider: "a + b",
    });
  });

  it("只有一个服务成功时保留其有效结果", () => {
    const result = { ip: "8.8.8.8", countryCode: "US", provider: "only" };
    expect(selectConsensusEgressIpInfo([result])).toEqual(result);
  });

  it("多个地区平票时拒绝自动判定", () => {
    expect(selectConsensusEgressIpInfo([
      { ip: "1.1.1.1", countryCode: "SG", provider: "a" },
      { ip: "2.2.2.2", countryCode: "TW", provider: "b" },
    ])).toBeNull();
  });

  it("只有超过全部来源半数时才允许提前结束查询", () => {
    const results = [
      { ip: "1.1.1.1", countryCode: "SG", provider: "a" },
      { ip: "1.1.1.1", countryCode: "SG", provider: "b" },
      { ip: "1.1.1.1", countryCode: "SG", provider: "c" },
      { ip: "1.1.1.1", countryCode: "SG", provider: "d" },
    ];
    expect(selectAbsoluteMajorityEgressIpInfo(results.slice(0, 3), 7)).toBeNull();
    expect(selectAbsoluteMajorityEgressIpInfo(results, 7)).toMatchObject({ countryCode: "SG" });
  });
});
