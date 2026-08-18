import type { NodeWithMeta, ParsedNode } from "@subboost/core/types/node";

export type RegionNamedNode = {
  sourceId: string;
  nodeIndex: number;
  name: string;
};

const REGION_LABEL_OVERRIDES: Record<string, string> = {
  CN: "中国大陆",
  HK: "香港",
  MO: "澳门",
  TW: "台湾",
  US: "美国",
  GB: "英国",
  KR: "韩国",
  KP: "朝鲜",
  RU: "俄罗斯",
  SG: "新加坡",
  JP: "日本",
};

const regionNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });

export function countryCodeToRegion(code: string | null | undefined): string {
  if (!code || !/^[A-Z]{2}$/i.test(code)) return "其他";
  const normalized = code.toUpperCase();
  return REGION_LABEL_OVERRIDES[normalized] ?? regionNames.of(normalized) ?? normalized;
}

export function detectNodeRegion(node: ParsedNode): string {
  // long: 自动区域只接受节点测试得到的真实代理出口，节点名称、入口域名和服务器 IP 不参与推断。
  return (node as NodeWithMeta)._meta?.region?.trim() || "其他";
}

export function buildRegionNodeNames(
  rows: Array<{ sourceId: string; nodeIndex: number; node: ParsedNode }>
): RegionNamedNode[] {
  const regions = rows.map((row) => detectNodeRegion(row.node));
  const totals = regions.reduce<Map<string, number>>((counts, region) => {
    counts.set(region, (counts.get(region) ?? 0) + 1);
    return counts;
  }, new Map());
  const sequences = new Map<string, number>();

  // long: 先统计区域总量再编号，使同一区域始终按来源和节点原顺序得到稳定、等宽的流水号。
  return rows.map((row, index) => {
    const region = regions[index];
    const sequence = (sequences.get(region) ?? 0) + 1;
    sequences.set(region, sequence);
    const width = Math.max(2, String(totals.get(region) ?? 1).length);
    return {
      sourceId: row.sourceId,
      nodeIndex: row.nodeIndex,
      name: `${region} ${String(sequence).padStart(width, "0")}`,
    };
  });
}
