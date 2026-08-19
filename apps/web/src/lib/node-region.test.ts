import { describe, expect, it } from "vitest";
import type { ParsedNode } from "@subboost/core/types/node";
import { buildRegionNodeNames, countryCodeToRegion, detectNodeRegion, UNKNOWN_NODE_REGION } from "./node-region";

function node(input: { name: string; server: string; region?: string }): ParsedNode {
  return {
    name: input.name,
    server: input.server,
    port: 443,
    type: "trojan",
    password: "test",
    ...(input.region ? { _meta: { region: input.region } } : {}),
  } as ParsedNode;
}

describe("node region naming", () => {
  it("only accepts tested egress metadata and ignores node names", () => {
    expect(detectNodeRegion(node({ name: "香港高速节点", server: "example.com", region: "美国" }))).toBe("美国");
    expect(detectNodeRegion(node({ name: "香港高速节点", server: "hk.example.com" }))).toBe(UNKNOWN_NODE_REGION);
  });

  it("renders egress ISO country codes as Chinese region labels", () => {
    expect(countryCodeToRegion("TW")).toBe("台湾");
    expect(countryCodeToRegion("sg")).toBe("新加坡");
    expect(countryCodeToRegion("DE")).toBe("德国");
    expect(countryCodeToRegion(null)).toBe("其他");
  });

  it("numbers nodes by their GeoIP region", () => {
    const names = buildRegionNodeNames([
      { sourceId: "a", nodeIndex: 0, node: node({ name: "A", server: "a.example.com", region: "日本" }) },
      { sourceId: "a", nodeIndex: 1, node: node({ name: "B", server: "b.example.com", region: "日本" }) },
      { sourceId: "b", nodeIndex: 0, node: node({ name: "C", server: "c.example.com", region: "新加坡" }) },
    ]);

    expect(names.map((item) => item.name)).toEqual(["日本 01", "日本 02", "新加坡 01"]);
  });
});
