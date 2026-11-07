import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { generateClashYaml } from "@subboost/core/generator";
import type { ClashConfig } from "@subboost/core/types/config";
import type { ParsedNode } from "@subboost/core/types/node";
import { createBuiltinTemplate, parseLiteTemplate } from "./lite-template";

function node(name: string, server: string): ParsedNode {
  return { name, type: "ss", server, port: 8388, cipher: "aes-128-gcm", password: "test-password" };
}

function exportConfig(template: ReturnType<typeof createBuiltinTemplate>): ClashConfig {
  return yaml.load(generateClashYaml({
    nodes: [
      node("备用节点", "backup.example.com"),
      node("余额 | 10GB", "info.example.com"),
      node("优先节点", "primary.example.com"),
    ],
    template: template.baseTemplate,
    userConfig: {
      enabledGroups: template.enabledModules,
      enabledRules: template.enabledModules,
      testUrl: template.testUrl,
      testInterval: template.testInterval,
    },
  })) as ClashConfig;
}

describe("内置模板故障转移", () => {
  it.each(["minimal", "standard", "full"] as const)("%s 模板导入导出后生成可选的故障转移组，保持原有分流", (type) => {
    const template = parseLiteTemplate(JSON.parse(JSON.stringify(createBuiltinTemplate(type))));
    template.testUrl = "https://probe.example.com/204";
    template.testInterval = 120;
    const config = exportConfig(template);
    const groups = config["proxy-groups"] ?? [];
    const group = (name: string) => groups.find((item) => item.name === name);

    expect(groups.slice(0, 3).map((item) => item.name)).toEqual(["🚀 节点选择", "⚡ 自动选择", "🛟 故障转移"]);
    expect(group("🛟 故障转移")).toMatchObject({
      type: "fallback",
      proxies: ["备用节点", "优先节点"],
      url: template.testUrl,
      interval: 120,
    });
    expect(group("🚀 节点选择")?.proxies?.slice(0, 2)).toEqual(["⚡ 自动选择", "🛟 故障转移"]);
    expect(group("⚡ 自动选择")?.type).toBe("url-test");
    expect(group("🐟 漏网之鱼")?.proxies?.[0]).toBe("🚀 节点选择");
    expect(group("🔒 国内服务")?.proxies?.[0]).toBe("DIRECT");
    expect(group("🏠 私有网络")?.proxies?.[0]).toBe("DIRECT");
    expect(group("🛑 广告拦截")?.proxies?.[0]).toBe("REJECT");
    expect(config.rules).toContain("RULE-SET,cn-ip,🔒 国内服务,no-resolve");
    expect(config.rules?.at(-1)).toBe("MATCH,🐟 漏网之鱼");
    expect(config["rule-providers"]).not.toHaveProperty("fallback");
  });

  it("关闭故障转移或导入未启用它的旧模板时不留下悬空引用", () => {
    const original = createBuiltinTemplate("standard");
    original.enabledModules = original.enabledModules.filter((id) => id !== "fallback");
    const template = parseLiteTemplate(JSON.parse(JSON.stringify(original)));
    const groups = exportConfig(template)["proxy-groups"] ?? [];

    expect(groups.some((group) => group.name === "🛟 故障转移")).toBe(false);
    expect(groups.every((group) => !group.proxies?.includes("🛟 故障转移"))).toBe(true);
    expect(groups.find((group) => group.name === "🚀 节点选择")?.proxies?.[0]).toBe("⚡ 自动选择");
  });
});
