import { DEFAULT_SUBBOOST_CONFIG } from "@subboost/core/config/defaults";
import { PROXY_GROUP_MODULES } from "@subboost/core/generator/proxy-groups";
import { DEFAULT_RULE_PROVIDER_BASE_URL } from "@subboost/core/rules/metadata";
import { TEMPLATES } from "@subboost/core/templates";
import type { DirectDomainRule, TemplateType } from "@subboost/core/types/config";

export const LITE_TEMPLATE_SCHEMA = "subconvert-template/v1" as const;
export const REQUIRED_MODULES = ["select", "final"] as const;
export const ADRULES_MIHOMO_URL = "https://adrules.top/adrules-mihomo.mrs";

export type AiRuleMode = "split" | "aggregate";
export type AdRuleMode = "light" | "enhanced";

export type LiteTemplate = {
  schema: typeof LITE_TEMPLATE_SCHEMA;
  name: string;
  description: string;
  baseTemplate: TemplateType;
  enabledModules: string[];
  mixedPort: number;
  allowLan: boolean;
  testUrl: string;
  testInterval: number;
  baseConfigYaml: string;
  directDomains: DirectDomainRule[];
  ruleProviderBaseUrl: string;
  experimentalCnUseCnRuleSet: boolean;
  aiRuleMode: AiRuleMode;
  adRuleMode: AdRuleMode;
};

const BUILTIN_NAMES: Record<TemplateType, string> = {
  minimal: "轻量分流",
  standard: "日常分流",
  full: "高级分流",
};

export function createBuiltinTemplate(type: TemplateType): LiteTemplate {
  const preset = TEMPLATES[type];
  return {
    schema: LITE_TEMPLATE_SCHEMA,
    name: BUILTIN_NAMES[type],
    description: preset.description,
    baseTemplate: type,
    enabledModules: [...preset.groups],
    mixedPort: DEFAULT_SUBBOOST_CONFIG.mixedPort,
    allowLan: DEFAULT_SUBBOOST_CONFIG.allowLan,
    testUrl: DEFAULT_SUBBOOST_CONFIG.testUrl,
    testInterval: DEFAULT_SUBBOOST_CONFIG.testInterval,
    baseConfigYaml: "",
    directDomains: [],
    ruleProviderBaseUrl: DEFAULT_RULE_PROVIDER_BASE_URL,
    experimentalCnUseCnRuleSet: type === "full",
    aiRuleMode: type === "full" ? "aggregate" : "split",
    adRuleMode: "light",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseLiteTemplate(value: unknown): LiteTemplate {
  if (!isRecord(value) || value.schema !== LITE_TEMPLATE_SCHEMA) {
    throw new Error("模板格式不匹配，需要 subconvert-template/v1");
  }

  const baseTemplate = value.baseTemplate;
  if (baseTemplate !== "minimal" && baseTemplate !== "standard" && baseTemplate !== "full") {
    throw new Error("模板的 baseTemplate 无效");
  }

  const availableIds = new Set(PROXY_GROUP_MODULES.map((module) => module.id));
  const enabledModules = Array.isArray(value.enabledModules)
    ? [...new Set(value.enabledModules.filter((id): id is string => typeof id === "string" && availableIds.has(id)))]
    : [];
  // long: 两个骨架组决定默认出口与最终兜底，导入模板时强制补齐，避免生成不可用配置。
  for (const required of REQUIRED_MODULES) {
    if (!enabledModules.includes(required)) enabledModules.push(required);
  }

  const mixedPort = Number(value.mixedPort);
  const testInterval = Number(value.testInterval);
  const aiRuleMode: AiRuleMode = value.aiRuleMode === "aggregate" ? "aggregate" : "split";
  const adRuleMode: AdRuleMode = value.adRuleMode === "enhanced" ? "enhanced" : "light";
  const directDomains = new Map<string, DirectDomainRule>();
  const addDomainRule = (item: unknown) => {
    const rawDomain = typeof item === "string" ? item : isRecord(item) && typeof item.domain === "string" ? item.domain : "";
    const domain = rawDomain.trim().toLowerCase().replace(/^(?:\*\.|\+\.)+/, "").replace(/\.+$/, "");
    if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(domain)) return;
    const nameservers = isRecord(item) && Array.isArray(item.nameservers)
      ? [...new Set(item.nameservers.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))]
      : [];
    const existing = directDomains.get(domain);
    directDomains.set(domain, { domain, nameservers: [...new Set([...(existing?.nameservers ?? []), ...nameservers])] });
  };
  if (Array.isArray(value.directDomains)) value.directDomains.forEach(addDomainRule);
  // long: 旧模板仍可能把带 DNS 的项目放在 internalDomains，导入时迁移到统一列表并保留专用解析。
  if (Array.isArray(value.internalDomains)) value.internalDomains.forEach(addDomainRule);
  const ruleProviderBaseUrl =
    typeof value.ruleProviderBaseUrl === "string" && /^https?:\/\//i.test(value.ruleProviderBaseUrl.trim())
      ? value.ruleProviderBaseUrl.trim().replace(/\/+$/, "")
      : DEFAULT_RULE_PROVIDER_BASE_URL;
  return {
    schema: LITE_TEMPLATE_SCHEMA,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim().slice(0, 80) : "自定义模板",
    description: typeof value.description === "string" ? value.description.trim().slice(0, 200) : "",
    baseTemplate,
    enabledModules,
    mixedPort: Number.isInteger(mixedPort) && mixedPort >= 1 && mixedPort <= 65535 ? mixedPort : DEFAULT_SUBBOOST_CONFIG.mixedPort,
    allowLan: typeof value.allowLan === "boolean" ? value.allowLan : DEFAULT_SUBBOOST_CONFIG.allowLan,
    testUrl: typeof value.testUrl === "string" && /^https?:\/\//.test(value.testUrl) ? value.testUrl : DEFAULT_SUBBOOST_CONFIG.testUrl,
    testInterval: Number.isInteger(testInterval) && testInterval >= 30 ? testInterval : DEFAULT_SUBBOOST_CONFIG.testInterval,
    baseConfigYaml: typeof value.baseConfigYaml === "string" ? value.baseConfigYaml : "",
    directDomains: [...directDomains.values()],
    ruleProviderBaseUrl,
    experimentalCnUseCnRuleSet:
      typeof value.experimentalCnUseCnRuleSet === "boolean"
        ? value.experimentalCnUseCnRuleSet
        : baseTemplate === "full",
    aiRuleMode,
    adRuleMode,
  };
}

export function safeFileName(name: string): string {
  return name.trim().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "subconvert";
}
