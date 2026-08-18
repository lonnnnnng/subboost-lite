export {
  DEFAULT_RULE_PROVIDER_BASE_URL,
  DEFAULT_RULE_PROVIDER_SOURCE,
  RULE_CATEGORIES,
  RULE_PROVIDER_CONFIG,
  RULE_PROVIDER_SOURCES,
  type RuleProviderSourceId,
  type RuleCategory,
} from "./provider-config";

import type { RuleCategory } from "./provider-config";

export interface RuleSetInfo {
  id: string;
  name: string;
  nameZh: string;
  category: RuleCategory;
  behavior: "domain" | "ipcidr";
  format: "mrs";
  url: string;
}
