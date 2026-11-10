"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Activity,
  Braces,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clipboard,
  Cloud,
  Code2,
  Download,
  Eye,
  FileJson,
  FileUp,
  Filter,
  Gauge,
  Github,
  Globe2,
  Link2,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Network,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
  ShieldCheck,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";
import { generateClashConfig, generateClashYaml } from "@subboost/core/generator";
import { PROXY_GROUP_MODULES } from "@subboost/core/generator/proxy-groups";
import { DEFAULT_BASE_CONFIG_YAML } from "@subboost/core/config/defaults";
import { parseBase64, parseSubscription } from "@subboost/core/parser";
import { RULE_PROVIDER_SOURCES } from "@subboost/core/rules/metadata";
import type { BuiltinRuleEdits, ClashConfig, DirectDomainRule, TemplateType } from "@subboost/core/types/config";
import type { NodeWithMeta, ParsedNode } from "@subboost/core/types/node";
import yaml from "js-yaml";
import { YamlHighlight } from "@/components/yaml-highlight";
import { copyText } from "@/lib/clipboard";
import {
  appendSubscriptionFileContents,
  mapSubscriptionImportsWithConcurrency,
  parseSubscriptionUrlBatch,
  runSubscriptionImportWithTimeout,
  type SubscriptionImportFailure,
} from "@/lib/batch-import";
import {
  ADRULES_MIHOMO_URL,
  createBuiltinTemplate,
  type LiteTemplate,
  parseLiteTemplate,
  REQUIRED_MODULES,
  safeFileName,
} from "@/lib/lite-template";
import { buildRegionNodeNames, countryCodeToRegion, detectNodeRegion, UNKNOWN_NODE_REGION } from "@/lib/node-region";
import { MAX_SPEED_TEST_NODES, type NodeTestApiResponse, type NodeTestMode, type NodeTestProgress, type NodeTestResult, type NodeTestStreamMessage, type SpeedTestSource } from "@/lib/node-test/types";

type SourceKind = "url" | "yaml" | "nodes";
type PreviewTab = "visual" | "yaml";
type SourceRecord = {
  id: string;
  kind: SourceKind;
  name: string;
  content: string;
  nodes: ParsedNode[];
  errors: string[];
};

type NodeRow = {
  sourceId: string;
  sourceName: string;
  nodeIndex: number;
  node: ParsedNode;
};

type ApiImportResponse =
  | { ok: true; reviewRequired: false; content: string; nodes: ParsedNode[]; errors: string[]; directDomains?: DirectDomainRule[]; baseConfigYaml?: string }
  | { ok: true; reviewRequired: true; reviewReason: string; content: string; nodes: ParsedNode[]; errors: string[]; directDomains?: DirectDomainRule[]; baseConfigYaml?: string }
  | { ok: false; error: string; detail?: string | null };

type PendingTlsReview = {
  url: string;
  reason: string;
  content: string;
  nodes: ParsedNode[];
  errors: string[];
  directDomains?: DirectDomainRule[];
  baseConfigYaml?: string;
};

type UrlImportOutcome =
  | { status: "ready"; url: string; content: string; nodes: ParsedNode[]; errors: string[]; directDomains?: DirectDomainRule[]; baseConfigYaml?: string }
  | { status: "review"; review: PendingTlsReview }
  | { status: "failed"; url: string; error: string };

type BatchImportResult = {
  successCount: number;
  failureCount: number;
  reviewCount: number;
  duplicateCount: number;
  failures: SubscriptionImportFailure[];
};

type BatchImportProgress = {
  total: number;
  completed: number;
  active: number;
  success: number;
  failure: number;
  review: number;
};

type NodeTestProgressSummary = {
  total: number;
  completed: number;
  available: number;
  failed: number;
};

const SOURCE_META: Record<SourceKind, { label: string; placeholder: string }> = {
  url: { label: "订阅链接", placeholder: "https://example.com/subscription\nhttps://example.net/subscription" },
  yaml: { label: "YAML 配置", placeholder: "proxies:\n  - name: example\n    type: ss\n    ..." },
  nodes: { label: "节点连接", placeholder: "ss://...\nvmess://...\nvless://..." },
};

const CATEGORY_META: Record<string, string> = {
  core: "核心",
  service: "服务",
  social: "社交",
  media: "媒体",
  game: "游戏",
  tech: "技术",
  finance: "金融",
  other: "其他",
};

function createId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function downloadText(content: string, fileName: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function sourceName(kind: SourceKind, value: string, index: number): string {
  if (kind === "url") {
    try {
      return new URL(value).hostname;
    } catch {
      return `订阅 ${index}`;
    }
  }
  return kind === "yaml" ? `YAML ${index}` : `节点 ${index}`;
}

function mergeImportedDirectDomains(current: DirectDomainRule[], imported: DirectDomainRule[] | undefined): DirectDomainRule[] {
  if (!imported || imported.length === 0) return current;
  const merged = new Map(current.map((item) => [item.domain.trim().toLowerCase(), { ...item, domain: item.domain.trim().toLowerCase() }]));
  for (const item of imported) {
    const domain = item.domain.trim().toLowerCase();
    if (!domain) continue;
    const existing = merged.get(domain);
    merged.set(domain, {
      domain,
      nameservers: [...new Set([...(existing?.nameservers ?? []), ...(item.nameservers ?? [])].map((value) => value.trim()).filter(Boolean))],
    });
  }
  return [...merged.values()];
}

function mergeImportedBaseConfigYaml(current: string, imported: string | undefined): string {
  if (!imported?.trim()) return current;
  if (!current.trim()) return imported.trim();
  try {
    const currentConfig = yaml.load(current) as Record<string, unknown>;
    const importedConfig = yaml.load(imported) as Record<string, unknown>;
    if (!currentConfig || typeof currentConfig !== "object" || Array.isArray(currentConfig)) return imported.trim();
    if (!importedConfig || typeof importedConfig !== "object" || Array.isArray(importedConfig)) return current;

    const merged: Record<string, unknown> = { ...currentConfig, ...importedConfig };
    for (const key of ["dns", "proxy-providers"]) {
      const left = currentConfig[key];
      const right = importedConfig[key];
      if (left && typeof left === "object" && !Array.isArray(left) && right && typeof right === "object" && !Array.isArray(right)) {
        merged[key] = { ...(left as Record<string, unknown>), ...(right as Record<string, unknown>) };
      }
    }
    return yaml.dump(merged, { noRefs: true, lineWidth: -1, sortKeys: false }).trim();
  } catch {
    // long: 用户可能正在编辑一段尚未完整的基础 YAML；保留原编辑内容，避免导入订阅时覆盖未完成配置。
    return current;
  }
}

function mergeImportedTemplateConfig(current: LiteTemplate, imported: { directDomains?: DirectDomainRule[]; baseConfigYaml?: string }): LiteTemplate {
  return {
    ...current,
    directDomains: mergeImportedDirectDomains(current.directDomains, imported.directDomains),
    baseConfigYaml: mergeImportedBaseConfigYaml(current.baseConfigYaml, imported.baseConfigYaml),
  };
}

function buildOutput(nodes: ParsedNode[], template: LiteTemplate) {
  if (nodes.length === 0) return { yaml: "", config: null as ClashConfig | null, error: "" };
  try {
  const userConfig = {
      enabledGroups: template.enabledModules,
      enabledRules: template.enabledModules,
      mixedPort: template.mixedPort,
      allowLan: template.allowLan,
      testUrl: template.testUrl,
      testInterval: template.testInterval,
      ruleProviderBaseUrl: template.ruleProviderBaseUrl,
      experimentalCnUseCnRuleSet: template.experimentalCnUseCnRuleSet,
      directDomains: template.directDomains,
      ...(template.baseConfigYaml.trim() ? { dnsYaml: template.baseConfigYaml } : {}),
    };
    const builtinRuleEdits: BuiltinRuleEdits = template.aiRuleMode === "split"
      ? { "module:ai:category-ai-chat-!cn": { enabled: false as const } }
      : {
          "module:ai:openai": { enabled: false as const },
          "module:ai:anthropic": { enabled: false as const },
        };
    const customRuleSets =
      template.adRuleMode === "enhanced" && template.enabledModules.includes("ad")
        ? [
            {
              id: "adrules-enhanced",
              name: "AdRules 增强广告",
              behavior: "domain" as const,
              path: ADRULES_MIHOMO_URL,
              target: { kind: "module" as const, id: "ad" },
            },
          ]
        : [];
    const options = {
      nodes,
      template: template.baseTemplate,
      userConfig,
      builtinRuleEdits,
      customRuleSets,
    };
    return {
      yaml: generateClashYaml(options),
      config: generateClashConfig(options),
      error: "",
    };
  } catch (error) {
    return {
      yaml: "",
      config: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function getProviderSourceId(baseUrl: string): keyof typeof RULE_PROVIDER_SOURCES | "custom" {
  const match = (Object.entries(RULE_PROVIDER_SOURCES) as Array<[
    keyof typeof RULE_PROVIDER_SOURCES,
    { baseUrl: string }
  ]>).find(([, source]) => source.baseUrl === baseUrl);
  return match?.[0] ?? "custom";
}

function normalizeNodeName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

const REVIEW_PREVIEW_LIMIT = 120_000;

function decodeReviewBase64(content: string): string | null {
  let normalized = content.trim();
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // long: URL 解码失败不影响标准 Base64 的人工审核，后续仍按原内容判断。
  }
  normalized = normalized.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");

  // long: 先严格识别 Base64 外形，避免把普通 YAML 交给宽松解码器后展示成乱码。
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  try {
    const decoded = parseBase64(content);
    return decoded.trim() ? decoded : null;
  } catch {
    return null;
  }
}

function buildReviewPreview(content: string): string {
  return content.length > REVIEW_PREVIEW_LIMIT
    ? `${content.slice(0, REVIEW_PREVIEW_LIMIT)}\n\n# 预览已截断，当前内容共 ${content.length.toLocaleString()} 字符`
    : content;
}

function makeUniqueNodeName(name: string, occupiedNames: Set<string>): string {
  if (!occupiedNames.has(name)) return name;
  let sequence = 2;
  while (occupiedNames.has(`${name} (${sequence})`)) sequence += 1;
  return `${name} (${sequence})`;
}

function nodeKey(sourceId: string, nodeIndex: number): string {
  return `${sourceId}:${nodeIndex}`;
}

function nodeIpForDedup(row: NodeRow): string | null {
  // long: 去重按订阅中“服务器”字段判断网络出口；不同端口仍共用同一服务器，因此必须归为同一节点。
  const server = String(row.node.server ?? "").trim().replace(/^\[|\]$/g, "");
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(server)) return server.toLowerCase();
  if (server.includes(":") && /^[0-9a-f:]+$/i.test(server)) return server.toLowerCase();
  return null;
}

function matchesLatencyFilter(latency: number | null, filter: string): boolean {
  if (filter === "all") return true;
  if (latency === null) return false;
  if (filter === "lt-1000") return latency < 1000;
  if (filter === "lt-2000") return latency < 2000;
  if (filter === "lt-3000") return latency < 3000;
  if (filter === "gt-3000") return latency > 3000;
  if (filter === "gt-5000") return latency > 5000;
  return true;
}

const REGION_OPTIONS = ["香港", "澳门", "台湾", "日本", "韩国", "新加坡", "美国", "加拿大", "英国", "德国", "法国", "澳大利亚", "印度", "俄罗斯", "中国大陆", "其他", UNKNOWN_NODE_REGION];

function getMatchingBuiltinTemplate(template: LiteTemplate): TemplateType | null {
  for (const type of ["minimal", "standard", "full"] as TemplateType[]) {
    if (JSON.stringify(template) === JSON.stringify(createBuiltinTemplate(type))) return type;
  }
  return null;
}

function formatLatency(meta: NodeWithMeta["_meta"]): string {
  const status = meta?.latencyTestStatus ?? meta?.proxyTestStatus;
  if (status === "unavailable" || status === "core-unavailable") return "—";
  if (typeof meta?.latency === "number" && Number.isFinite(meta.latency)) return `${Math.round(meta.latency)} ms`;
  if (typeof meta?.tcpLatency === "number" && Number.isFinite(meta.tcpLatency)) return `${Math.round(meta.tcpLatency)} ms TCP`;
  return "—";
}

function formatSpeed(meta: NodeWithMeta["_meta"], testing = false): string {
  if (testing && !Number.isFinite(meta?.downloadCurrentMbps) && !Number.isFinite(meta?.downloadPeakMbps)) return "准备中";
  if (meta?.speedTestStatus === "unavailable" || meta?.speedTestStatus === "core-unavailable") return "测试失败";
  const current = typeof meta?.downloadCurrentMbps === "number" && Number.isFinite(meta.downloadCurrentMbps)
    ? meta.downloadCurrentMbps.toFixed(1)
    : null;
  const peak = typeof meta?.downloadPeakMbps === "number" && Number.isFinite(meta.downloadPeakMbps)
    ? meta.downloadPeakMbps.toFixed(1)
    : null;
  const average = typeof meta?.downloadSpeedMbps === "number" && Number.isFinite(meta.downloadSpeedMbps)
    ? meta.downloadSpeedMbps.toFixed(1)
    : null;
  if (testing && (current || peak)) return `当前 ${current ?? "—"} · 峰值 ${peak ?? "—"} Mbps`;
  if (average || peak) return `平均 ${average ?? "—"} · 峰值 ${peak ?? "—"} Mbps`;
  return "—";
}

function formatSpeedDetails(meta: NodeWithMeta["_meta"]): string | undefined {
  if (typeof meta?.downloadSpeedMbps !== "number") return meta?.speedTestError;
  const parts = [
    meta.downloadSource ? `来源 ${meta.downloadSource}` : "",
    typeof meta.downloadDurationSeconds === "number" ? `稳态 ${meta.downloadDurationSeconds.toFixed(1)} 秒` : "",
    typeof meta.downloadSampleBytes === "number" ? `样本 ${(meta.downloadSampleBytes / 1_000_000).toFixed(1)} MB` : "",
    typeof meta.downloadPeakMbps === "number" ? `峰值 ${meta.downloadPeakMbps.toFixed(1)} Mbps` : "",
    typeof meta.downloadStabilityPercent === "number" ? `稳定度 ${meta.downloadStabilityPercent.toFixed(1)}%` : "",
    meta.downloadFailedStreams ? `失败流 ${meta.downloadFailedStreams}` : "",
    meta.downloadStopReason === "data-limit" ? "达到采样上限" : meta.downloadStopReason === "stream-error" ? "存在失败流" : "按时长结束",
  ].filter(Boolean);
  return parts.join(" · ");
}

function connectivityLabel(meta: NodeWithMeta["_meta"]): { label: string; tone: "ok" | "warn" | "bad" | "muted" } {
  const status = meta?.latencyTestStatus ?? meta?.proxyTestStatus;
  if (status === "available") return { label: "可用", tone: "ok" };
  // long: TCP 建连成功不代表代理协议可用，代理探测明确失败时必须优先提示失败，避免用户误把端口状态当成节点可用。
  if (status === "unavailable" || status === "core-unavailable") return { label: "测试失败", tone: "bad" };
  if (meta?.tcpReachable) return { label: "端口通", tone: "warn" };
  if (status === "unsupported") return { label: "不支持", tone: "muted" };
  return { label: "未测试", tone: "muted" };
}

function NodeRegionEditor({ value, onCommit, label, hint }: { value: string; onCommit: (region: string) => void; label: string; hint?: string }) {
  const [draft, setDraft] = useState(value);

  function commit() {
    const normalized = draft.trim() || "其他";
    setDraft(normalized);
    if (normalized !== value) onCommit(normalized);
  }

  return (
    <div className="node-region-editor">
      <input
        className={`node-region-input${value === UNKNOWN_NODE_REGION ? " pending" : ""}`}
        list="node-region-options"
        value={draft}
        aria-label={label}
        title={hint || value}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}
function NodeNameEditor({ value, onCommit, label }: { value: string; onCommit: (name: string) => string; label: string }) {
  const [draft, setDraft] = useState(value);

  function commit() {
    setDraft(onCommit(draft));
  }

  return (
    <input
      className="node-name-input"
      value={draft}
      aria-label={label}
      title={value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

type ProviderSourceOptionId = keyof typeof RULE_PROVIDER_SOURCES | "custom";

const PROVIDER_SOURCE_OPTIONS: Array<{ id: ProviderSourceOptionId; label: string }> = [
  ...(Object.entries(RULE_PROVIDER_SOURCES) as Array<[
    keyof typeof RULE_PROVIDER_SOURCES,
    { label: string; baseUrl: string }
  ]>).map(([id, source]) => ({ id, label: source.label })),
  { id: "custom", label: "自定义 URL 前缀" },
];

function ProviderSourceSelect({ value, onChange }: { value: ProviderSourceOptionId; onChange: (value: ProviderSourceOptionId) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedOption = PROVIDER_SOURCE_OPTIONS.find((option) => option.id === value) ?? PROVIDER_SOURCE_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  function handleOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const options = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>("[role='option']") ?? []);
    const currentIndex = options.indexOf(event.currentTarget);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1) % options.length
          : (currentIndex - 1 + options.length) % options.length;
    options[nextIndex]?.focus();
  }

  return (
    <div className="provider-source-select" ref={rootRef}>
      <button
        id="provider-source"
        ref={triggerRef}
        className="form-control provider-source-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="provider-source-options"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
          if (event.key === "Escape") setOpen(false);
        }}
      >
        <span>{selectedOption.label}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div id="provider-source-options" className="provider-source-menu" role="listbox" aria-label="规则集下载源选项">
          {PROVIDER_SOURCE_OPTIONS.map((option) => (
            <button
              key={option.id}
              className={`provider-source-option${option.id === value ? " selected" : ""}`}
              type="button"
              role="option"
              aria-selected={option.id === value}
              autoFocus={option.id === value}
              onKeyDown={handleOptionKeyDown}
              onClick={() => {
                onChange(option.id);
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              <span>{option.label}</span>
              {option.id === value ? <Check size={15} aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Workbench() {
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [sourceKind, setSourceKind] = useState<SourceKind>("url");
  const [sourceInput, setSourceInput] = useState("");
  const [template, setTemplate] = useState<LiteTemplate>(() => createBuiltinTemplate("standard"));
  const [previewTab, setPreviewTab] = useState<PreviewTab>("visual");
  const [busy, setBusy] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isNodeListFullscreen, setIsNodeListFullscreen] = useState(false);
  const [nodeNameFilter, setNodeNameFilter] = useState("");
  const [nodeIpFilter, setNodeIpFilter] = useState("");
  const [nodeRegionFilter, setNodeRegionFilter] = useState("all");
  const [nodeProtocolFilter, setNodeProtocolFilter] = useState("all");
  const [nodeConnectivityFilter, setNodeConnectivityFilter] = useState("all");
  const [nodeLatencyFilter, setNodeLatencyFilter] = useState("all");
  const [selectedNodeKeys, setSelectedNodeKeys] = useState<Set<string>>(() => new Set());
  const [testingNodeKeys, setTestingNodeKeys] = useState<Set<string>>(() => new Set());
  const [testingMode, setTestingMode] = useState<NodeTestMode | null>(null);
  const [nodeTestProgress, setNodeTestProgress] = useState<NodeTestProgressSummary | null>(null);
  const [connectivityTimeoutSeconds, setConnectivityTimeoutSeconds] = useState(3.5);
  const [speedTestDurationSeconds, setSpeedTestDurationSeconds] = useState(15);
  const [speedTestConcurrency, setSpeedTestConcurrency] = useState(10);
  const [speedTestSource, setSpeedTestSource] = useState<SpeedTestSource>("cloudflare");
  const [speedTestCustomUrl, setSpeedTestCustomUrl] = useState("");
  const [speedTestMaxDataMb, setSpeedTestMaxDataMb] = useState(300);
  const [pendingTlsReviews, setPendingTlsReviews] = useState<PendingTlsReview[]>([]);
  const pendingTlsReview = pendingTlsReviews[0] ?? null;
  const [batchImportResult, setBatchImportResult] = useState<BatchImportResult | null>(null);
  const [batchImportProgress, setBatchImportProgress] = useState<BatchImportProgress | null>(null);
  const [viewingNodeKey, setViewingNodeKey] = useState<string | null>(null);
  const [baseYamlPreviewOpen, setBaseYamlPreviewOpen] = useState(false);
  const [showDecodedReview, setShowDecodedReview] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const sourceInputRef = useRef<HTMLTextAreaElement>(null);
  const urlFileRef = useRef<HTMLInputElement>(null);
  const yamlFileRef = useRef<HTMLInputElement>(null);
  const templateFileRef = useRef<HTMLInputElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const nodeListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(document.fullscreenElement === document.documentElement);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    handleFullscreenChange();
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => setIsNodeListFullscreen(Boolean(nodeListRef.current) && document.fullscreenElement === nodeListRef.current);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    handleFullscreenChange();
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (!pendingTlsReview || batchImportResult) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowDecodedReview(false);
        setPendingTlsReviews((current) => current.slice(1));
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [batchImportResult, pendingTlsReview]);

  const nodeRows = useMemo<NodeRow[]>(() => sources.flatMap((source) => source.nodes.map((node, nodeIndex) => ({
    sourceId: source.id,
    sourceName: source.name,
    nodeIndex,
    node,
  }))), [sources]);
  const viewingNodeIndex = viewingNodeKey ? nodeRows.findIndex((row) => nodeKey(row.sourceId, row.nodeIndex) === viewingNodeKey) : -1;
  const viewingNodeRow = viewingNodeIndex >= 0 ? nodeRows[viewingNodeIndex] : null;

  useEffect(() => {
    if (!viewingNodeKey) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setViewingNodeKey(null);
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [viewingNodeKey]);
  const regionFilterOptions = useMemo(() => [...new Set([
    ...nodeRows.map((row) => detectNodeRegion(row.node)),
    ...(nodeRegionFilter !== "all" ? [nodeRegionFilter] : []),
  ])].sort((a, b) => a.localeCompare(b, "zh-CN")), [nodeRegionFilter, nodeRows]);
  const protocolFilterOptions = useMemo(() => [...new Set([
    ...nodeRows.map((row) => String(row.node.type ?? "").toLowerCase()).filter(Boolean),
    ...(nodeProtocolFilter !== "all" ? [nodeProtocolFilter] : []),
  ])].sort(), [nodeProtocolFilter, nodeRows]);
  const visibleNodeRows = useMemo(() => {
    const nameKeyword = nodeNameFilter.trim().toLowerCase();
    const ipKeyword = nodeIpFilter.trim().toLowerCase();
    return nodeRows.filter((row) => {
      const meta = (row.node as NodeWithMeta)._meta;
      const name = String(row.node.name ?? "").toLowerCase();
      const egressIp = String(meta?.egressIp ?? "").toLowerCase();
      const server = String(row.node.server ?? "").toLowerCase();
      const region = detectNodeRegion(row.node);
      const protocol = String(row.node.type ?? "").toLowerCase();
      const connectivity = connectivityLabel(meta).label;
      const latency = typeof meta?.latency === "number" && Number.isFinite(meta.latency) ? meta.latency : null;
      if (nameKeyword && !name.includes(nameKeyword)) return false;
      if (ipKeyword && !egressIp.includes(ipKeyword) && !server.includes(ipKeyword)) return false;
      if (nodeRegionFilter !== "all" && region !== nodeRegionFilter) return false;
      if (nodeProtocolFilter !== "all" && protocol !== nodeProtocolFilter) return false;
      if (nodeConnectivityFilter !== "all" && connectivity !== nodeConnectivityFilter) return false;
      return matchesLatencyFilter(latency, nodeLatencyFilter);
    });
  }, [nodeRows, nodeNameFilter, nodeIpFilter, nodeRegionFilter, nodeProtocolFilter, nodeConnectivityFilter, nodeLatencyFilter]);
  const visibleSelectedRows = useMemo(
    () => visibleNodeRows.filter((row) => selectedNodeKeys.has(nodeKey(row.sourceId, row.nodeIndex))),
    [visibleNodeRows, selectedNodeKeys]
  );
  const duplicateNodeKeys = useMemo(() => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    // long: 按当前列表顺序保留每个 IP 的第一条记录，后续重复项才进入待删除集合，确保结果可预期。
    nodeRows.forEach((row) => {
      const ip = nodeIpForDedup(row);
      if (!ip) return;
      const key = nodeKey(row.sourceId, row.nodeIndex);
      if (seen.has(ip)) duplicates.add(key);
      else seen.add(ip);
    });
    return duplicates;
  }, [nodeRows]);
  const mainlandNodeKeys = useMemo(() => new Set(nodeRows
    .filter((row) => detectNodeRegion(row.node) === "中国大陆")
    .map((row) => nodeKey(row.sourceId, row.nodeIndex))), [nodeRows]);
  const regionReadyRows = useMemo(() => nodeRows.filter((row) => detectNodeRegion(row.node) !== UNKNOWN_NODE_REGION), [nodeRows]);
  const allNodesSelected = visibleNodeRows.length > 0 && visibleSelectedRows.length === visibleNodeRows.length;
  const someNodesSelected = visibleSelectedRows.length > 0 && !allNodesSelected;
  const allNodes = useMemo(() => nodeRows.map((row) => row.node), [nodeRows]);
  const output = useMemo(() => buildOutput(allNodes, template), [allNodes, template]);
  const matchingBuiltinTemplate = useMemo(() => getMatchingBuiltinTemplate(template), [template]);
  const groups = (output.config?.["proxy-groups"] ?? []) as Array<{
    name: string;
    type: string;
    proxies?: string[];
  }>;
  const ruleCount = PROXY_GROUP_MODULES
    .filter((module) => template.enabledModules.includes(module.id))
    .reduce((total, module) => total + module.rules.length, 0) +
    (template.adRuleMode === "enhanced" && template.enabledModules.includes("ad") ? 1 : 0) +
    template.directDomains.length;
  const categories = [...new Set(PROXY_GROUP_MODULES.map((module) => module.category))];
  const enabledModuleCount = PROXY_GROUP_MODULES.filter((module) => template.enabledModules.includes(module.id)).length;
  const providerSourceId = getProviderSourceId(template.ruleProviderBaseUrl);
  const decodedReviewContent = useMemo(
    () => pendingTlsReview ? decodeReviewBase64(pendingTlsReview.content) : null,
    [pendingTlsReview]
  );
  const sourceInputLineCount = useMemo(
    () => sourceInput.split(/\r?\n/).filter((line) => line.trim()).length,
    [sourceInput]
  );
  const reviewPreview = pendingTlsReview
    ? buildReviewPreview(showDecodedReview && decodedReviewContent ? decodedReviewContent : pendingTlsReview.content)
    : "";

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someNodesSelected;
  }, [someNodesSelected]);

  function showNotice(tone: "ok" | "error", text: string) {
    setNotice({ tone, text });
    window.setTimeout(() => setNotice((current) => current?.text === text ? null : current), 3200);
  }

  function selectSourceKind(kind: SourceKind) {
    if (kind !== sourceKind) {
      // long: 不同来源的文本格式互斥，快捷入口也必须清空旧内容，避免切换后误解析上一种格式。
      setSourceKind(kind);
      setSourceInput("");
    }
    window.setTimeout(() => sourceInputRef.current?.focus(), 0);
  }

  function handleSourceShortcut(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void handleAddSource();
    }
  }

  function advanceTlsReview() {
    setShowDecodedReview(false);
    setPendingTlsReviews((current) => current.slice(1));
  }

  function renameNode(sourceId: string, nodeIndex: number, rawName: string): string {
    const target = sources.find((source) => source.id === sourceId)?.nodes[nodeIndex];
    if (!target) return rawName;

    const normalized = normalizeNodeName(rawName);
    if (!normalized) {
      showNotice("error", "节点名称不能为空，已恢复原名称");
      return target.name;
    }

    const occupiedNames = new Set(nodeRows
      .filter((row) => row.sourceId !== sourceId || row.nodeIndex !== nodeIndex)
      .map((row) => row.node.name));
    const uniqueName = makeUniqueNodeName(normalized, occupiedNames);
    if (uniqueName === target.name) return target.name;

    // long: 节点名称是代理组引用的主键，因此只替换目标节点对象，让生成器基于新的完整节点集合重建所有引用。
    setSources((current) => current.map((source) => source.id !== sourceId ? source : {
      ...source,
      nodes: source.nodes.map((node, index) => index === nodeIndex ? { ...node, name: uniqueName } : node),
    }));
    showNotice("ok", uniqueName === normalized ? `已重命名为 ${uniqueName}` : `名称重复，已调整为 ${uniqueName}`);
    return uniqueName;
  }

  function renameNodesByRegion() {
    if (regionReadyRows.length === 0) {
      showNotice("error", "请先完成节点测试或手动填写区域，再按区域命名");
      return;
    }
    const renamedNodes = buildRegionNodeNames(regionReadyRows);
    const nameByPosition = new Map(renamedNodes.map((item) => [`${item.sourceId}:${item.nodeIndex}`, item.name]));

    // long: 批量命名在一次状态更新中完成，避免中途生成包含一半新名称、一半旧名称的配置预览。
    setSources((current) => current.map((source) => ({
      ...source,
      nodes: source.nodes.map((node, nodeIndex) => ({
        ...node,
        name: nameByPosition.get(`${source.id}:${nodeIndex}`) ?? node.name,
      })),
    })));
    showNotice("ok", `已按区域重命名 ${renamedNodes.length} 个节点${renamedNodes.length < nodeRows.length ? `，${nodeRows.length - renamedNodes.length} 个待测试节点保留原名` : ""}`);
  }

  function setNodeRegion(sourceId: string, nodeIndex: number, region: string) {
    const normalized = region.trim() || "其他";
    setSources((current) => current.map((source) => source.id !== sourceId ? source : {
      ...source,
      nodes: source.nodes.map((node, index) => index === nodeIndex ? {
        ...node,
        _meta: { ...(node as NodeWithMeta)._meta, region: normalized },
      } : node),
    }));
  }

  function toggleNodeSelection(key: string, checked: boolean) {
    setSelectedNodeKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function toggleAllNodes(checked: boolean) {
    setSelectedNodeKeys((current) => {
      const next = new Set(current);
      // long: 筛选后的全选只改变可见节点，避免用户看不到的节点被连带测试、测速或删除。
      visibleNodeRows.forEach((row) => {
        const key = nodeKey(row.sourceId, row.nodeIndex);
        if (checked) next.add(key);
        else next.delete(key);
      });
      return next;
    });
  }

  function removeNodes(keys: Set<string>, targetLabel = "选中的") {
    if (keys.size === 0) return;
    const shouldDelete = window.confirm(`确定删除${targetLabel} ${keys.size} 个节点吗？此操作不会影响来源文件。`);
    if (!shouldDelete) return;
    setSources((current) => current
      .map((source) => ({
        ...source,
        nodes: source.nodes.filter((_, index) => !keys.has(nodeKey(source.id, index))),
      }))
      .filter((source) => source.nodes.length > 0));
    setSelectedNodeKeys(new Set());
    showNotice("ok", `已删除 ${keys.size} 个节点`);
  }

  function removeDuplicateNodes() {
    removeNodes(duplicateNodeKeys, "重复 IP 节点");
  }

  function removeMainlandNodes() {
    removeNodes(mainlandNodeKeys, "中国大陆");
  }

  function resetNodeFilters() {
    setNodeNameFilter("");
    setNodeIpFilter("");
    setNodeRegionFilter("all");
    setNodeProtocolFilter("all");
    setNodeConnectivityFilter("all");
    setNodeLatencyFilter("all");
  }

  function removeSource(sourceId: string) {
    setSources((current) => current.filter((source) => source.id !== sourceId));
    setSelectedNodeKeys(new Set());
  }

  function applyNodeTestResult(result: NodeTestResult, mode: NodeTestMode) {
    const [sourceId, rawIndex] = result.key.split(":");
    const nodeIndex = Number(rawIndex);
    if (!sourceId || !Number.isInteger(nodeIndex)) return;
    setSources((current) => current.map((source) => source.id !== sourceId ? source : {
      ...source,
      nodes: source.nodes.map((node, index) => {
        if (index !== nodeIndex) return node;
        const meta = (node as NodeWithMeta)._meta;
        const egressRegion = result.proxy.egressCountryCode
          ? countryCodeToRegion(result.proxy.egressCountryCode)
          : undefined;
        const egressMeta = {
          ...(egressRegion && egressRegion !== "其他" ? { region: egressRegion } : {}),
          ...(result.proxy.egressIp ? { egressIp: result.proxy.egressIp } : {}),
          ...(result.proxy.egressCountryCode ? { egressCountryCode: result.proxy.egressCountryCode } : {}),
          ...(result.proxy.egressProvider ? { egressProvider: result.proxy.egressProvider } : {}),
          egressError: result.proxy.egressError,
        };
        return {
          ...node,
          _meta: mode === "latency" ? {
            ...meta,
            ...egressMeta,
            tcpReachable: result.tcp.status === "reachable",
            tcpLatency: result.tcp.latencyMs,
            latency: result.proxy.latencyMs,
            latencyTestStatus: result.proxy.status,
            latencyTestError: result.proxy.error || result.tcp.error,
            testedAt: result.testedAt,
          } : {
            ...meta,
            ...egressMeta,
            downloadCurrentMbps: undefined,
            downloadSpeedMbps: result.proxy.downloadSpeedMbps,
            downloadSampleBytes: result.proxy.downloadSampleBytes,
            downloadTransferredBytes: result.proxy.downloadTransferredBytes,
            downloadComplete: result.proxy.downloadComplete,
            downloadPeakMbps: result.proxy.downloadPeakMbps,
            downloadStabilityPercent: result.proxy.downloadStabilityPercent,
            downloadDurationSeconds: result.proxy.downloadDurationSeconds,
            downloadSource: result.proxy.downloadSource,
            downloadStopReason: result.proxy.downloadStopReason,
            downloadFailedStreams: result.proxy.downloadFailedStreams,
            downloadSampleCount: result.proxy.downloadSampleCount,
            speedTestStatus: result.proxy.status,
            speedTestError: result.proxy.error || result.tcp.error,
            testedAt: result.testedAt,
          },
        };
      }),
    }));
  }

  function applyNodeTestProgress(progress: NodeTestProgress) {
    const [sourceId, rawIndex] = progress.key.split(":");
    const nodeIndex = Number(rawIndex);
    if (!sourceId || !Number.isInteger(nodeIndex)) return;
    setSources((current) => current.map((source) => source.id !== sourceId ? source : {
      ...source,
      nodes: source.nodes.map((node, index) => {
        if (index !== nodeIndex) return node;
        const meta = (node as NodeWithMeta)._meta;
        return {
          ...node,
          _meta: {
            ...meta,
            downloadCurrentMbps: progress.proxy.downloadCurrentMbps,
            downloadPeakMbps: progress.proxy.downloadPeakMbps,
            downloadSampleBytes: progress.proxy.downloadSampleBytes,
            downloadTransferredBytes: progress.proxy.downloadTransferredBytes,
            downloadDurationSeconds: progress.proxy.downloadDurationSeconds,
            speedTestStatus: "available",
            testedAt: progress.testedAt,
          },
        };
      }),
    }));
  }

  async function readNodeTestResponse(response: Response, mode: NodeTestMode): Promise<NodeTestApiResponse> {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/x-ndjson") || !response.body) {
      return await response.json() as NodeTestApiResponse;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed: Extract<NodeTestApiResponse, { ok: true }> | null = null;
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      const message = JSON.parse(line) as NodeTestStreamMessage;
      if (message.type === "progress") {
        if (message.mode === mode) applyNodeTestProgress(message);
        return;
      }
      if (message.type === "result") {
        if (message.mode === mode) {
          applyNodeTestResult(message.result, message.mode);
          if (mode === "latency") {
            setNodeTestProgress((current) => current ? {
              ...current,
              completed: current.completed + 1,
              available: current.available + (message.result.proxy.status === "available" ? 1 : 0),
              failed: current.failed + (message.result.proxy.status === "available" ? 0 : 1),
            } : current);
          }
          setTestingNodeKeys((current) => {
            const next = new Set(current);
            next.delete(message.result.key);
            return next;
          });
        }
        return;
      }
      if (message.type === "error") throw new Error(message.error);
      if (message.type === "complete") completed = message;
    };
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.forEach(handleLine);
      if (chunk.done) break;
    }
    if (buffer.trim()) handleLine(buffer);
    if (!completed) throw new Error("节点测试未返回最终结果");
    return completed;
  }

  async function testRows(rows: NodeRow[], mode: NodeTestMode) {
    if (rows.length === 0) {
      showNotice("error", "请先选择节点");
      return;
    }
    // long: 下载测速会持续占用带宽和 Mihomo 实例，因此只限制测速批次；轻量的连通/延迟探测允许一次处理全部所选节点。
    if (mode === "speed" && rows.length > MAX_SPEED_TEST_NODES) {
      showNotice("error", `单次最多测速 ${MAX_SPEED_TEST_NODES} 个节点，请分批选择`);
      return;
    }
    const keys = rows.map((row) => nodeKey(row.sourceId, row.nodeIndex));
    if (mode === "speed") {
      const keySet = new Set(keys);
      // long: 新一轮测速开始前清空上次瞬时值，预热阶段不能把旧峰值误当成当前结果。
      setSources((current) => current.map((source) => ({
        ...source,
        nodes: source.nodes.map((node, index) => keySet.has(nodeKey(source.id, index)) ? {
          ...node,
          _meta: {
            ...(node as NodeWithMeta)._meta,
            downloadCurrentMbps: undefined,
            downloadPeakMbps: undefined,
            speedTestStatus: undefined,
            speedTestError: undefined,
          },
        } : node),
      })));
    }
    setTestingMode(mode);
    if (mode === "latency") {
      setNodeTestProgress({ total: rows.length, completed: 0, available: 0, failed: 0 });
    } else {
      setNodeTestProgress(null);
    }
    setTestingNodeKeys((current) => new Set([...current, ...keys]));
    try {
      const response = await fetch("/api/node-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodes: rows.map((row) => ({ key: nodeKey(row.sourceId, row.nodeIndex), node: row.node })),
          mode,
          ...(mode === "speed" ? { durationSeconds: speedTestDurationSeconds, speedConcurrency: speedTestConcurrency } : {}),
          ...(mode === "speed" ? {
            speedSource: speedTestSource,
            speedUrl: speedTestSource === "custom" ? speedTestCustomUrl : undefined,
            speedMaxDataMb: speedTestMaxDataMb,
          } : {}),
          tcpTimeoutSeconds: connectivityTimeoutSeconds,
        }),
      });
      const result = await readNodeTestResponse(response, mode);
      if (!result.ok) throw new Error(result.error);
      result.results.forEach((item) => applyNodeTestResult(item, result.mode));
      if (mode === "latency") {
        setNodeTestProgress({
          total: rows.length,
          completed: result.results.length,
          available: result.results.filter((item) => item.proxy.status === "available").length,
          failed: result.results.filter((item) => item.proxy.status !== "available").length,
        });
      }
      const availableCount = result.results.filter((item) => item.proxy.status === "available").length;
      showNotice("ok", `${mode === "latency" ? "连通/延迟测试" : "下载测速"}完成：${availableCount}/${result.results.length} 个节点可用${result.coreVersion ? ` · Mihomo ${result.coreVersion}` : ""}`);
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : "节点测试失败");
    } finally {
      setTestingNodeKeys((current) => {
        const next = new Set(current);
        keys.forEach((key) => next.delete(key));
        return next;
      });
      setTestingMode(null);
      setNodeTestProgress(null);
    }
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      showNotice("error", "当前浏览器不允许进入全屏");
    }
  }

  async function toggleNodeListFullscreen() {
    try {
      if (document.fullscreenElement === nodeListRef.current) {
        await document.exitFullscreen();
      } else if (nodeListRef.current) {
        await nodeListRef.current.requestFullscreen();
      }
    } catch {
      showNotice("error", "当前浏览器不允许节点列表进入全屏");
    }
  }

  function addParsedSource(
    kind: SourceKind,
    content: string,
    nodes: ParsedNode[],
    errors: string[],
    name?: string,
    options: { preserveInput?: boolean; directDomainCount?: number; baseConfigImported?: boolean } = {}
  ) {
    const nextIndex = sources.length + 1;
    setSources((current) => [
      ...current,
      {
        id: createId(),
        kind,
        name: name || sourceName(kind, content, nextIndex),
        content,
        nodes,
        errors,
      },
    ]);
    if (!options.preserveInput) setSourceInput("");
    const details = [
      options.directDomainCount ? `同步 ${options.directDomainCount} 个直连域名` : "",
      options.baseConfigImported ? "已保留基础配置" : "",
    ].filter(Boolean);
    showNotice("ok", `已导入 ${nodes.length} 个节点${details.length > 0 ? `，${details.join("，")}` : ""}`);
  }

  async function confirmTlsReview() {
    if (!pendingTlsReview) return;
    const review = pendingTlsReview;
    setBusy(true);
    try {
      // long: 批量失败链接仍保留在输入框中，审核通过不能顺带清除用户下一步需要重试的内容。
      setTemplate((current) => mergeImportedTemplateConfig(current, review));
      await addParsedSource("url", review.content, review.nodes, review.errors, sourceName("url", review.url, sources.length + 1), {
        preserveInput: true,
        directDomainCount: review.directDomains?.length,
        baseConfigImported: Boolean(review.baseConfigYaml),
      });
      advanceTlsReview();
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : "审核来源加入失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleAddSource() {
    if (busy) return;
    const value = sourceInput.trim();
    if (!value) {
      showNotice("error", `请输入${SOURCE_META[sourceKind].label}`);
      return;
    }

    setBusy(true);
    try {
      if (sourceKind !== "url") {
        const parsed = parseSubscription(value);
        if (parsed.nodes.length === 0 && !parsed.baseConfigYaml) {
          showNotice("error", parsed.errors[0] || "未识别到有效节点");
          return;
        }
        if (sourceKind === "yaml") {
          setTemplate((current) => mergeImportedTemplateConfig(current, parsed));
        }
        await addParsedSource(sourceKind, value, parsed.nodes, parsed.errors, undefined, {
          directDomainCount: parsed.directDomains?.length,
          baseConfigImported: Boolean(parsed.baseConfigYaml),
        });
        return;
      }

      const { urls, duplicateCount } = parseSubscriptionUrlBatch(value);
      if (urls.length === 0) {
        showNotice("error", "请输入至少一个订阅链接");
        return;
      }
      const isBatchImport = urls.length + duplicateCount > 1;

      // long: 并发池领取链接后才启动该条的 15 秒计时，浏览器连接排队不会让后面的订阅提前超时。
      setBatchImportProgress({ total: urls.length, completed: 0, active: 0, success: 0, failure: 0, review: 0 });
      const outcomes = await mapSubscriptionImportsWithConcurrency(urls, async (url): Promise<UrlImportOutcome> => {
        setBatchImportProgress((current) => current ? { ...current, active: current.active + 1 } : current);
        let outcome: UrlImportOutcome;
        try {
          const result = await runSubscriptionImportWithTimeout(async (signal) => {
            const response = await fetch("/api/import", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url }),
              signal,
            });
            return await response.json() as ApiImportResponse;
          });
          if (!result.ok) {
            outcome = { status: "failed", url, error: result.detail || result.error };
          } else if (result.reviewRequired) {
            outcome = {
              status: "review",
              review: {
                url,
                reason: result.reviewReason,
                content: result.content,
                nodes: result.nodes,
                errors: result.errors,
                directDomains: result.directDomains,
                baseConfigYaml: result.baseConfigYaml,
              },
            };
          } else {
            outcome = {
              status: "ready",
              url,
              content: result.content,
              nodes: result.nodes,
              errors: result.errors,
              directDomains: result.directDomains,
              baseConfigYaml: result.baseConfigYaml,
            };
          }
        } catch (error) {
          outcome = { status: "failed", url, error: error instanceof Error ? error.message : "订阅链接导入失败" };
        }
        setBatchImportProgress((current) => {
          if (!current) return current;
          return {
            ...current,
            active: Math.max(0, current.active - 1),
            completed: current.completed + 1,
            success: current.success + (outcome.status === "ready" ? 1 : 0),
            failure: current.failure + (outcome.status === "failed" ? 1 : 0),
            review: current.review + (outcome.status === "review" ? 1 : 0),
          };
        });
        return outcome;
      });

      const readyOutcomes = outcomes.filter((outcome): outcome is Extract<UrlImportOutcome, { status: "ready" }> => outcome.status === "ready");
      const reviewQueue = outcomes
        .filter((outcome): outcome is Extract<UrlImportOutcome, { status: "review" }> => outcome.status === "review")
        .map((outcome) => outcome.review);
      const requestFailures = outcomes.filter((outcome): outcome is Extract<UrlImportOutcome, { status: "failed" }> => outcome.status === "failed");

      // long: 导入只负责保留订阅节点；实际出口地区在节点测试时取得，避免把入口服务器误标为出口区域。
      const failures = requestFailures;

      if (readyOutcomes.length > 0) {
        setSources((current) => [
          ...current,
          ...readyOutcomes.map((outcome, index): SourceRecord => ({
            id: createId(),
            kind: "url",
            name: sourceName("url", outcome.url, current.length + index + 1),
            content: outcome.content,
            nodes: outcome.nodes,
            errors: outcome.errors,
          })),
        ]);
      }

      if (readyOutcomes.length > 0) {
        setTemplate((current) => readyOutcomes.reduce(
          (next, outcome) => mergeImportedTemplateConfig(next, outcome),
          current
        ));
      }

      setSourceInput(failures.map((item) => item.url).join("\n"));
      setShowDecodedReview(false);
      setPendingTlsReviews(reviewQueue);

      if (isBatchImport || failures.length > 0) {
        // long: 单链接失败也保留结果直到确认，避免短暂通知消失后看起来像没反应；批量审核仍在汇总确认后进行。
        setNotice(null);
        setBatchImportResult({
          successCount: readyOutcomes.length,
          failureCount: failures.length,
          reviewCount: reviewQueue.length,
          duplicateCount,
          failures,
        });
        return;
      }

      const summary = [
        `${readyOutcomes.length} 个已导入`,
        `${reviewQueue.length} 个待审核`,
        `${failures.length} 个失败`,
        ...(duplicateCount > 0 ? [`忽略 ${duplicateCount} 个重复链接`] : []),
      ].join(" · ");
      showNotice(reviewQueue.length > 0 ? "error" : "ok", `订阅处理完成：${summary}`);
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : "订阅链接导入失败");
    } finally {
      setBusy(false);
      setBatchImportProgress(null);
    }
  }

  async function handleYamlFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const content = await file.text();
      const parsed = parseSubscription(content);
      if (parsed.nodes.length === 0 && !parsed.baseConfigYaml) {
        showNotice("error", parsed.errors[0] || "YAML 中没有可用节点");
        return;
      }
      setTemplate((current) => mergeImportedTemplateConfig(current, parsed));
      await addParsedSource("yaml", content, parsed.nodes, parsed.errors, file.name, {
        directDomainCount: parsed.directDomains?.length,
        baseConfigImported: Boolean(parsed.baseConfigYaml),
      });
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : "YAML 文件导入失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleUrlFiles(files: FileList | null) {
    if (!files?.length) return;
    try {
      const selectedFiles = Array.from(files);
      const contents = await Promise.all(selectedFiles.map((file) => file.text()));
      setSourceInput((current) => appendSubscriptionFileContents(current, contents));
      showNotice("ok", `已追加 ${selectedFiles.length} 个订阅链接文件`);
      window.setTimeout(() => sourceInputRef.current?.focus(), 0);
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : "订阅链接文件读取失败");
    }
  }

  async function handleTemplateFile(file: File | undefined) {
    if (!file) return;
    try {
      const imported = parseLiteTemplate(JSON.parse(await file.text()));
      setTemplate(imported);
      showNotice("ok", `已应用模板：${imported.name}`);
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : "模板文件无效");
    }
  }

  function applyBuiltin(type: TemplateType) {
    setTemplate(createBuiltinTemplate(type));
  }

  function addDirectDomain() {
    setTemplate((current) => ({ ...current, directDomains: [...current.directDomains, { domain: "", nameservers: [] }] }));
  }

  function updateDirectDomain(index: number, patch: Partial<DirectDomainRule>) {
    setTemplate((current) => ({
      ...current,
      directDomains: current.directDomains.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
    }));
  }

  function removeDirectDomain(index: number) {
    setTemplate((current) => ({
      ...current,
      directDomains: current.directDomains.filter((_, itemIndex) => itemIndex !== index),
    }));
  }

  function toggleModule(id: string) {
    if ((REQUIRED_MODULES as readonly string[]).includes(id)) return;
    setTemplate((current) => ({
      ...current,
      name: current.name.endsWith(" · 自定义") ? current.name : `${current.name} · 自定义`,
      enabledModules: current.enabledModules.includes(id)
        ? current.enabledModules.filter((moduleId) => moduleId !== id)
        : [...current.enabledModules, id],
    }));
  }

  function exportTemplate() {
    const fileName = `${safeFileName(template.name)}.template.json`;
    downloadText(`${JSON.stringify(template, null, 2)}\n`, fileName, "application/json;charset=utf-8");
    showNotice("ok", `模板已导出：${fileName}`);
  }

  function exportNodes() {
    const selectedRows = nodeRows.filter((row) => selectedNodeKeys.has(nodeKey(row.sourceId, row.nodeIndex)));
    const rowsToExport = selectedRows.length > 0 ? selectedRows : nodeRows;
    if (rowsToExport.length === 0) return;
    // long: 导出时只保留可被 Clash/Mihomo 解析的节点字段，测试结果等运行时元数据不能混入可复用节点配置。
    const proxies = rowsToExport.map((row) => Object.fromEntries(
      Object.entries(row.node).filter(([key]) => !key.startsWith("_"))
    ));
    const fileName = `${safeFileName(template.name)}-nodes.yaml`;
    downloadText(yaml.dump({ proxies }, { noRefs: true, lineWidth: -1, sortKeys: false }), fileName, "text/yaml;charset=utf-8");
    showNotice("ok", `已导出 ${rowsToExport.length} 个节点，可直接粘贴回“节点连接”输入框`);
  }

  function restoreDefaultTemplate() {
    const presetType = matchingBuiltinTemplate ?? "standard";
    setTemplate(createBuiltinTemplate(presetType));
    setBaseYamlPreviewOpen(false);
    showNotice("ok", `已恢复${presetType === "full" ? "高级" : presetType === "minimal" ? "轻量" : "日常"}预设模板，节点信息已保留`);
  }

  function downloadConfig() {
    if (!output.yaml) return;
    const fileName = `${safeFileName(template.name)}.yaml`;
    downloadText(output.yaml, fileName, "text/yaml;charset=utf-8");
    showNotice("ok", `配置已下载：${fileName}`);
  }

  async function copyYaml() {
    if (!output.yaml) return;
    try {
      await copyText(output.yaml);
      showNotice("ok", "YAML 配置已复制到剪贴板");
    } catch {
      showNotice("error", "复制失败，请检查浏览器剪贴板权限");
    }
  }

  return (
    <main className="app-shell" aria-busy={busy || testingNodeKeys.size > 0}>
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">S/</span>
          <div>
            <h1>SubConvert Lite</h1>
            <p>FILE WORKBENCH</p>
          </div>
        </div>
        <div className="topbar-status" aria-live="polite">
          <span><strong>{sources.length}</strong> 来源</span>
          <span><strong>{allNodes.length}</strong> 节点</span>
          <span><strong>{template.enabledModules.length}</strong> 模块</span>
        </div>
        <div className="topbar-actions">
          <div className={`topbar-output-state ${output.error ? "is-error" : allNodes.length > 0 ? "is-ready" : ""}`} aria-live="polite">
            <i />
            <span>{output.error ? "配置有误" : allNodes.length > 0 ? "配置就绪" : "等待来源"}</span>
          </div>
          <button className="icon-button" type="button" onClick={() => void toggleFullscreen()} title={isFullscreen ? "退出全屏" : "进入全屏"} aria-label={isFullscreen ? "退出全屏" : "进入全屏"}>
            {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
          <a className="icon-button" href="https://github.com/SubBoost/subboost" target="_blank" rel="noreferrer" title="查看上游项目">
            <Github size={18} />
          </a>
          <button className="primary-button" type="button" onClick={downloadConfig} disabled={!output.yaml || Boolean(output.error)}>
            <Download size={17} />
            下载配置
          </button>
        </div>
      </header>

      {notice ? <div className={`notice notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"} aria-live={notice.tone === "error" ? "assertive" : "polite"}><span>{notice.tone === "ok" ? <Check size={16} /> : <CircleAlert size={16} />}</span>{notice.text}</div> : null}

      <div className="workspace">
        <section className="panel source-panel" aria-labelledby="source-title">
          <div className="panel-heading">
            <div><span className="step-index">01</span><h2 id="source-title">导入来源</h2></div>
            {sources.length > 0 ? <button className="text-button danger" type="button" disabled={testingNodeKeys.size > 0} onClick={() => { setSources([]); setSelectedNodeKeys(new Set()); }}>清空</button> : null}
          </div>

          <div className="segmented" aria-label="来源类型">
            {(Object.keys(SOURCE_META) as SourceKind[]).map((kind) => (
              <button
                key={kind}
                type="button"
                className={sourceKind === kind ? "active" : ""}
                disabled={busy}
                onClick={() => selectSourceKind(kind)}
              >
                {kind === "url" ? <Link2 size={15} /> : kind === "yaml" ? <Code2 size={15} /> : <Network size={15} />}
                {SOURCE_META[kind].label}
              </button>
            ))}
          </div>

          {sourceKind === "url" ? (
            <textarea ref={sourceInputRef} className="source-input source-input-urls" value={sourceInput} onChange={(event) => setSourceInput(event.target.value)} onKeyDown={handleSourceShortcut} placeholder={SOURCE_META.url.placeholder} spellCheck={false} aria-describedby="source-input-meta" aria-keyshortcuts="Control+Enter Meta+Enter" />
          ) : (
            <textarea ref={sourceInputRef} className="source-input" value={sourceInput} onChange={(event) => setSourceInput(event.target.value)} onKeyDown={handleSourceShortcut} placeholder={SOURCE_META[sourceKind].placeholder} spellCheck={false} aria-describedby="source-input-meta" aria-keyshortcuts="Control+Enter Meta+Enter" />
          )}

          <div id="source-input-meta" className="source-input-meta" role="status" aria-live="polite">
            <span>{sourceKind === "url" ? "每行一个链接，证书异常会进入人工审核" : sourceKind === "yaml" ? "支持完整 Clash / Mihomo YAML 配置" : "每行一个节点连接，支持 ss / vmess / vless"}</span>
            <strong>{sourceInputLineCount > 0 ? `${sourceInputLineCount} 行待处理` : "等待输入"}</strong>
          </div>

          {batchImportProgress ? (
            <div className="batch-import-progress" role="status" aria-live="polite">
              <div className="batch-import-progress-heading">
                <strong>正在导入订阅</strong>
                <span>{batchImportProgress.completed} / {batchImportProgress.total} 已完成 · {batchImportProgress.active} 条处理中 · {Math.max(0, batchImportProgress.total - batchImportProgress.completed - batchImportProgress.active)} 条排队</span>
              </div>
              <div
                className="batch-import-progress-track"
                role="progressbar"
                aria-label="批量订阅导入进度"
                aria-valuemin={0}
                aria-valuemax={batchImportProgress.total}
                aria-valuenow={batchImportProgress.completed}
              >
                <i style={{ width: `${Math.round((batchImportProgress.completed / batchImportProgress.total) * 100)}%` }} />
              </div>
              <div className="batch-import-progress-stats">
                <span className="success">成功 <strong>{batchImportProgress.success}</strong></span>
                <span className="failure">失败 <strong>{batchImportProgress.failure}</strong></span>
                <span className="review">待审核 <strong>{batchImportProgress.review}</strong></span>
              </div>
            </div>
          ) : null}

          <div className="source-actions">
            {sourceKind === "url" ? (
              <>
                <input ref={urlFileRef} className="sr-only" type="file" multiple accept=".txt,.list,.conf,text/plain" onChange={(event) => { void handleUrlFiles(event.target.files); event.currentTarget.value = ""; }} />
                <button className="secondary-button" type="button" disabled={busy} onClick={() => urlFileRef.current?.click()}><FileUp size={16} />选择文件</button>
              </>
            ) : sourceKind === "yaml" ? (
              <>
                <input ref={yamlFileRef} className="sr-only" type="file" accept=".yaml,.yml,text/yaml,application/yaml" onChange={(event) => { void handleYamlFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
                <button className="secondary-button" type="button" onClick={() => yamlFileRef.current?.click()}><FileUp size={16} />选择文件</button>
              </>
            ) : <span />}
            {sourceInput.trim() ? <button className="secondary-button compact-button source-clear-button" type="button" onClick={() => { setSourceInput(""); window.setTimeout(() => sourceInputRef.current?.focus(), 0); }} disabled={busy} title="清空当前输入" aria-label="清空当前输入"><X size={15} />清空输入</button> : null}
            <button className="accent-button" type="button" onClick={() => void handleAddSource()} disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
              {batchImportProgress ? `导入中 ${batchImportProgress.completed}/${batchImportProgress.total}` : busy ? "导入中" : sourceKind === "url" ? "批量导入" : "加入来源"}
            </button>
          </div>

          <div className="source-list">
            {sources.length === 0 ? (
              <div className="empty-state"><Upload size={22} /><span>等待导入</span></div>
            ) : sources.map((source, index) => (
              <article className={`source-item${source.errors.length ? " has-errors" : ""}`} key={source.id} title={source.errors.length ? source.errors.join("\n") : undefined}>
                <div className="source-order">{String(index + 1).padStart(2, "0")}</div>
                <div className="source-info">
                  <strong>{source.name}</strong>
                  <span>{SOURCE_META[source.kind].label} · {source.nodes.length} 节点{source.errors.length ? ` · ${source.errors.length} 条提示` : ""}</span>
                </div>
                {source.errors.length ? <span className="source-warning" role="img" aria-label={`${source.errors.length} 条解析提示`}><CircleAlert size={14} /><small>{source.errors.length} 条提示</small></span> : null}
                <button className="icon-button compact" type="button" title="移除来源" disabled={testingNodeKeys.size > 0} onClick={() => removeSource(source.id)}><Trash2 size={15} /></button>
              </article>
            ))}
          </div>
        </section>

        <section className="panel template-panel" aria-labelledby="template-title">
          <div className="panel-heading">
            <div><span className="step-index">02</span><h2 id="template-title">规则模板</h2>{matchingBuiltinTemplate ? <span className="template-state builtin">内置预设</span> : <span className="template-state custom">已自定义</span>}</div>
            <div className="heading-actions">
              <input ref={templateFileRef} className="sr-only" type="file" accept=".json,application/json" onChange={(event) => { void handleTemplateFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
              <button className="icon-button compact" type="button" title="导入模板文件" aria-label="导入模板文件" onClick={() => templateFileRef.current?.click()}><FileUp size={15} /></button>
              <button className="icon-button compact" type="button" title="导出模板文件" aria-label="导出模板文件" onClick={exportTemplate}><FileJson size={15} /></button>
            </div>
          </div>

          <div className="template-presets">
            {(["minimal", "standard", "full"] as TemplateType[]).map((type) => {
              const labels: Record<TemplateType, string> = { minimal: "轻量", standard: "日常", full: "高级" };
              return <button key={type} type="button" className={matchingBuiltinTemplate === type ? "active" : ""} onClick={() => applyBuiltin(type)}>{labels[type]}</button>;
            })}
          </div>
          <p className="template-description">{template.description}</p>

          <div className="optimization-settings" aria-label="规则优化设置">
            <div className="optimization-heading"><span><Cloud size={14} />下载与规则策略</span><small>适配 FlClash / Mihomo</small></div>
            <div className="provider-policy-row">
              <div className="provider-policy-control">
                <label className="field-label" htmlFor="provider-source">规则集下载源</label>
                <ProviderSourceSelect
                  value={providerSourceId}
                  onChange={(source) => {
                    if (source === "custom") {
                      setTemplate((current) => ({ ...current, ruleProviderBaseUrl: "https://rules.example.com/geo" }));
                      return;
                    }
                    setTemplate((current) => ({ ...current, ruleProviderBaseUrl: RULE_PROVIDER_SOURCES[source].baseUrl }));
                  }}
                />
              </div>
              <label className="switch-field optimization-switch"><span>完整国内域名规则</span><input type="checkbox" checked={template.experimentalCnUseCnRuleSet} onChange={(event) => setTemplate((current) => ({ ...current, experimentalCnUseCnRuleSet: event.target.checked }))} /><i /></label>
            </div>
            {providerSourceId === "custom" ? (
              <input
                className="form-control custom-source-url"
                value={template.ruleProviderBaseUrl}
                onChange={(event) => setTemplate((current) => ({ ...current, ruleProviderBaseUrl: event.target.value }))}
                placeholder="https://rules.example.com/geo"
                aria-label="自定义规则集 URL 前缀"
              />
            ) : null}

            <div className="strategy-grid">
              <div className="strategy-control">
                <span className="strategy-label"><Bot size={14} />AI 规则</span>
                <div className="mini-segmented" role="group" aria-label="AI 规则模式">
                  <button type="button" className={template.aiRuleMode === "split" ? "active" : ""} onClick={() => setTemplate((current) => ({ ...current, aiRuleMode: "split" }))}>细分</button>
                  <button type="button" className={template.aiRuleMode === "aggregate" ? "active" : ""} onClick={() => setTemplate((current) => ({ ...current, aiRuleMode: "aggregate" }))}>聚合</button>
                </div>
              </div>
              <div className="strategy-control">
                <span className="strategy-label"><ShieldCheck size={14} />广告拦截</span>
                <div className="mini-segmented" role="group" aria-label="广告拦截模式">
                  <button type="button" className={template.adRuleMode === "light" ? "active" : ""} onClick={() => setTemplate((current) => ({ ...current, adRuleMode: "light" }))}>轻量</button>
                  <button type="button" className={template.adRuleMode === "enhanced" ? "active" : ""} onClick={() => setTemplate((current) => ({ ...current, adRuleMode: "enhanced" }))}>AdRules</button>
                </div>
              </div>
            </div>
          </div>

          <details className="advanced-settings module-settings">
            <summary><SlidersHorizontal size={15} /><span>分流规则模块</span><small className="module-settings-count">{enabledModuleCount}/{PROXY_GROUP_MODULES.length} 已启用</small><ChevronRight size={15} /></summary>
            <div className="advanced-body module-settings-body">
              <div className="module-list">
                {categories.map((category) => {
                  const modules = PROXY_GROUP_MODULES.filter((module) => module.category === category);
                  return (
                    <div className="module-category" key={category}>
                      <div className="category-heading"><span>{CATEGORY_META[category]}</span><small>{modules.filter((module) => template.enabledModules.includes(module.id)).length}/{modules.length}</small></div>
                      <div className="module-grid">
                        {modules.map((module) => {
                          const checked = template.enabledModules.includes(module.id);
                          const required = (REQUIRED_MODULES as readonly string[]).includes(module.id);
                          return (
                            <label className={`module-toggle ${checked ? "checked" : ""} ${required ? "required" : ""}`} key={module.id} title={module.description}>
                              <input type="checkbox" checked={checked} disabled={required} onChange={() => toggleModule(module.id)} />
                              <span className="module-emoji">{module.emoji}</span>
                              <span>{module.name.replace(module.emoji, "").trim()}</span>
                              <i>{module.rules.length}</i>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </details>

          <details className="advanced-settings">
            <summary><SlidersHorizontal size={15} />基础配置<ChevronRight size={15} /></summary>
            <div className="advanced-body">
              <div className="advanced-body-heading">
                <strong>基础配置 / DNS YAML</strong>
                <button className="secondary-button compact-button" type="button" onClick={() => setBaseYamlPreviewOpen(true)}><Eye size={14} />查看</button>
              </div>
              <div className="field-row">
                <label><span>Mixed 端口</span><input className="form-control" type="number" min="1" max="65535" value={template.mixedPort} onChange={(event) => setTemplate((current) => ({ ...current, mixedPort: Number(event.target.value) }))} /></label>
                <label className="switch-field"><span>允许局域网</span><input type="checkbox" checked={template.allowLan} onChange={(event) => setTemplate((current) => ({ ...current, allowLan: event.target.checked }))} /><i /></label>
              </div>
              <div className="direct-domain-settings">
                <div className="internal-domain-heading">
                  <div>
                    <span className="field-label">直连域名</span>
                    <small>域名必填，专用 DNS 可选；不填 DNS 只生成直连规则，填写后会额外绕过 Fake-IP 并使用指定解析。</small>
                  </div>
                  <button className="secondary-button compact-button" type="button" onClick={addDirectDomain}><Plus size={14} />添加域名</button>
                </div>
                {template.directDomains.length === 0 ? (
                  <div className="internal-domain-empty">暂无直连域名，例如添加 baidu.com 后，该域名及其子域名会跳过代理。</div>
                ) : (
                  <div className="internal-domain-list">
                    {template.directDomains.map((item, index) => (
                      <div className="internal-domain-row direct-domain-row" key={`direct-domain-${index}`}>
                        <input
                          className="form-control"
                          value={item.domain}
                          onChange={(event) => updateDirectDomain(index, { domain: event.target.value })}
                          placeholder="例如 baidu.com"
                          aria-label={`直连域名 ${index + 1}`}
                        />
                        <input
                          className="form-control"
                          value={(item.nameservers ?? []).join(", ")}
                          onChange={(event) => updateDirectDomain(index, { nameservers: event.target.value.split(/[\\s,;，；]+/).map((entry) => entry.trim()).filter(Boolean) })}
                          placeholder="专用 DNS（可选），逗号分隔"
                          aria-label={`直连域名 ${index + 1} 的专用 DNS 地址`}
                        />
                        <button className="icon-button compact" type="button" title="删除直连域名" onClick={() => removeDirectDomain(index)}><Trash2 size={14} /></button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <label className="field-label" htmlFor="base-yaml">编辑配置</label>
              <textarea id="base-yaml" className="base-yaml" spellCheck={false} value={template.baseConfigYaml} onChange={(event) => setTemplate((current) => ({ ...current, baseConfigYaml: event.target.value }))} placeholder="导入完整 YAML 后会自动保留基础配置；留空使用内置安全配置" />
              <div className="base-yaml-actions">
                <span>查看窗口使用语法高亮，固定显示约 20 行内容。</span>
                <button className="secondary-button compact-button" type="button" onClick={restoreDefaultTemplate}><RotateCcw size={14} />恢复默认</button>
              </div>
            </div>
          </details>
        </section>

        <section className="panel preview-panel" aria-labelledby="preview-title">
          <div className="preview-toolbar">
            <div><span className="step-index">03</span><h2 id="preview-title">配置预览</h2></div>
            <div className="preview-actions">
              <button className="icon-button compact" type="button" title="复制 YAML" aria-label="复制 YAML" onClick={() => void copyYaml()} disabled={!output.yaml}><Clipboard size={15} /></button>
              <button className="secondary-button compact-button" type="button" onClick={downloadConfig} disabled={!output.yaml} title="下载当前 YAML 配置"><Download size={15} />YAML</button>
            </div>
          </div>

          <div className="preview-stats">
            <div><span>PROXIES</span><strong>{allNodes.length}</strong></div>
            <div><span>GROUPS</span><strong>{groups.length}</strong></div>
            <div><span>RULE SETS</span><strong>{ruleCount}</strong></div>
          </div>

          <div className="preview-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={previewTab === "visual"} className={previewTab === "visual" ? "active" : ""} onClick={() => setPreviewTab("visual")}><Network size={15} />可视化</button>
            <button type="button" role="tab" aria-selected={previewTab === "yaml"} className={previewTab === "yaml" ? "active" : ""} onClick={() => setPreviewTab("yaml")}><Braces size={15} />YAML</button>
          </div>

          <div className={`preview-content${!output.error && allNodes.length > 0 && previewTab === "visual" ? " preview-content-node-list" : ""}`}>
            {output.error ? <div className="error-state"><CircleAlert size={22} /><strong>生成失败</strong><span>{output.error}</span></div> : null}
            {!output.error && allNodes.length === 0 ? (
              <div className="preview-empty">
                <div className="preview-empty-mark"><Network size={28} /></div>
                <strong>从任意来源开始</strong>
                <span>配置会在导入节点后自动生成，模板设置会实时生效。</span>
                <div className="preview-empty-actions" aria-label="快速导入">
                  <button type="button" onClick={() => selectSourceKind("url")}>
                    <Link2 size={16} />
                    <span><b>订阅链接</b><small>支持批量 URL</small></span>
                  </button>
                  <button type="button" onClick={() => { selectSourceKind("yaml"); yamlFileRef.current?.click(); }}>
                    <FileUp size={16} />
                    <span><b>YAML 配置</b><small>上传或粘贴文件</small></span>
                  </button>
                  <button type="button" onClick={() => selectSourceKind("nodes")}>
                    <Network size={16} />
                    <span><b>节点连接</b><small>粘贴 ss / vless</small></span>
                  </button>
                </div>
              </div>
            ) : null}
            {!output.error && allNodes.length > 0 && previewTab === "visual" ? (
              <div className="node-list-view" ref={nodeListRef}>
                <div className="node-list-toolbar">
                  <div>
                    <strong>节点列表</strong>
                    <span>{testingNodeKeys.size > 0 ? `正在${testingMode === "speed" ? "测速" : "测试连通性与延迟"} · ${testingNodeKeys.size} 个节点` : `显示 ${visibleNodeRows.length} / ${nodeRows.length} 个 · 当前筛选内选中 ${visibleSelectedRows.length} 个`}</span>
                    <span className="node-table-scroll-hint">左右滑动表格查看完整信息和操作</span>
                  </div>
                  <div className="node-list-actions">
                    <div className="node-test-group">
                      <label className="node-test-duration" title="节点服务器 TCP 建连超时，范围 1-30 秒">
                        <span>超时</span>
                        <input type="number" min={1} max={30} step={0.5} value={connectivityTimeoutSeconds} aria-label="连通性超时秒数" onChange={(event) => {
                          const next = Number(event.target.value);
                          if (Number.isFinite(next)) setConnectivityTimeoutSeconds(Math.min(30, Math.max(1, Math.round(next * 2) / 2)));
                        }} />
                        <span>秒</span>
                      </label>
                      <button className="secondary-button compact-button" type="button" onClick={() => void testRows(visibleSelectedRows, "latency")} disabled={testingNodeKeys.size > 0 || visibleSelectedRows.length === 0} title="测试当前筛选中选中节点的连通性和代理延迟">
                        {testingNodeKeys.size > 0 && testingMode === "latency" ? <LoaderCircle className="spin" size={15} /> : <Activity size={15} />}连通/延迟
                      </button>
                    </div>
                    <div className="node-test-group">
                      <label className="node-test-duration" title="每个节点的持续下载测速窗口，范围 15-300 秒">
                        <span>时长</span>
                        <input type="number" min={15} max={300} step={15} value={speedTestDurationSeconds} aria-label="测速秒数" onChange={(event) => {
                          const next = Number(event.target.value);
                          if (Number.isFinite(next)) setSpeedTestDurationSeconds(Math.min(300, Math.max(15, Math.round(next))));
                        }} />
                        <span>秒</span>
                      </label>
                      <label className="node-test-duration" title="并行下载连接数，范围 1-100；总采样量不会随并发数增加">
                        <span>并发</span>
                        <input type="number" min={1} max={100} step={1} value={speedTestConcurrency} aria-label="测速并发数" onChange={(event) => {
                          const next = Number(event.target.value);
                          if (Number.isFinite(next)) setSpeedTestConcurrency(Math.min(100, Math.max(1, Math.round(next))));
                        }} />
                      </label>
                      <label className="node-test-duration" title="测速采样上限，达到后提前结束；按稳态样本计算结果">
                        <span>上限</span>
                        <input type="number" min={50} max={2048} step={50} value={speedTestMaxDataMb} aria-label="测速采样上限 MB" onChange={(event) => {
                          const next = Number(event.target.value);
                          if (Number.isFinite(next)) setSpeedTestMaxDataMb(Math.min(2048, Math.max(50, Math.round(next))));
                        }} />
                        <span>MB</span>
                      </label>
                      <label className="node-test-duration node-test-source" title="测速源不会混合统计，结果中会记录来源">
                        <span>来源</span>
                        <select value={speedTestSource} aria-label="测速来源" onChange={(event) => setSpeedTestSource(event.target.value as SpeedTestSource)}>
                          <option value="cloudflare">Cloudflare</option>
                          <option value="github">GitHub Release</option>
                          <option value="custom">自定义</option>
                        </select>
                      </label>
                      {speedTestSource === "custom" ? <input className="node-test-custom-url" type="url" value={speedTestCustomUrl} placeholder="https://..." aria-label="自定义测速地址" onChange={(event) => setSpeedTestCustomUrl(event.target.value)} /> : null}
                      <button className="secondary-button compact-button" type="button" onClick={() => void testRows(visibleSelectedRows, "speed")} disabled={testingNodeKeys.size > 0 || visibleSelectedRows.length === 0} title={`使用 ${speedTestConcurrency} 条并行下载流测试当前筛选中选中节点，采样上限 ${speedTestMaxDataMb} MB`}>
                        {testingNodeKeys.size > 0 && testingMode === "speed" ? <LoaderCircle className="spin" size={15} /> : <Gauge size={15} />}测速
                      </button>
                    </div>
                    <button className="secondary-button compact-button danger-button" type="button" onClick={() => removeNodes(new Set(visibleSelectedRows.map((row) => nodeKey(row.sourceId, row.nodeIndex))))} disabled={testingNodeKeys.size > 0 || visibleSelectedRows.length === 0} title="删除当前筛选中选中的节点">
                      <Trash2 size={15} />删除选中
                    </button>
                    <button className="secondary-button compact-button" type="button" onClick={exportNodes} disabled={testingNodeKeys.size > 0 || nodeRows.length === 0} title={selectedNodeKeys.size > 0 ? `导出已选中的 ${selectedNodeKeys.size} 个节点` : `导出全部 ${nodeRows.length} 个节点`}>
                      <Download size={15} />导出节点
                    </button>
                    <button className="secondary-button compact-button" type="button" onClick={renameNodesByRegion} disabled={testingNodeKeys.size > 0 || regionReadyRows.length === 0} title={regionReadyRows.length > 0 ? "根据已识别的节点区域批量命名" : "请先测试节点或手动填写区域"}>
                      <WandSparkles size={15} />按区域命名
                    </button>
                    <button className="secondary-button compact-button" type="button" onClick={removeDuplicateNodes} disabled={testingNodeKeys.size > 0 || duplicateNodeKeys.size === 0} title={duplicateNodeKeys.size > 0 ? `同一 IP 只保留第一条，将删除 ${duplicateNodeKeys.size} 个节点` : "没有发现重复 IP 节点"}>
                      <Filter size={15} />一键去重 ({duplicateNodeKeys.size})
                    </button>
                    <button className="secondary-button compact-button" type="button" onClick={removeMainlandNodes} disabled={testingNodeKeys.size > 0 || mainlandNodeKeys.size === 0} title={mainlandNodeKeys.size > 0 ? `移除 ${mainlandNodeKeys.size} 个中国大陆节点` : "没有区域为中国大陆的节点"}>
                      <Globe2 size={15} />非大陆 ({mainlandNodeKeys.size})
                    </button>
                    <button className="icon-button compact" type="button" onClick={() => void toggleNodeListFullscreen()} title={isNodeListFullscreen ? "退出节点列表全屏" : "节点列表全屏"} aria-label={isNodeListFullscreen ? "退出节点列表全屏" : "节点列表全屏"}>
                      {isNodeListFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                    </button>
                  </div>
                </div>
                {nodeTestProgress ? (
                  <div className="batch-import-progress node-test-progress" role="status" aria-live="polite">
                    <div className="batch-import-progress-heading">
                      <strong>正在测试连通性与延迟</strong>
                      <span>{nodeTestProgress.completed} / {nodeTestProgress.total} 已完成 · {nodeTestProgress.total - nodeTestProgress.completed} 个待返回</span>
                    </div>
                    <div
                      className="batch-import-progress-track"
                      role="progressbar"
                      aria-label="节点连通性与延迟测试进度"
                      aria-valuemin={0}
                      aria-valuemax={nodeTestProgress.total}
                      aria-valuenow={nodeTestProgress.completed}
                    >
                      <i style={{ width: `${Math.round((nodeTestProgress.completed / nodeTestProgress.total) * 100)}%` }} />
                    </div>
                    <div className="batch-import-progress-stats">
                      <span className="success">可用 <strong>{nodeTestProgress.available}</strong></span>
                      <span className="failure">测试失败 <strong>{nodeTestProgress.failed}</strong></span>
                    </div>
                  </div>
                ) : null}
                <div className="node-filter-bar" aria-label="节点筛选">
                  <div className="node-filter-search">
                    <Search size={14} aria-hidden="true" />
                    <input value={nodeNameFilter} onChange={(event) => setNodeNameFilter(event.target.value)} placeholder="按名称搜索" aria-label="按节点名称搜索" />
                  </div>
                  <div className="node-filter-search node-filter-ip">
                    <Search size={14} aria-hidden="true" />
                    <input value={nodeIpFilter} onChange={(event) => setNodeIpFilter(event.target.value)} placeholder="按 IP 搜索" aria-label="按 IP 搜索" />
                  </div>
                  <label className="node-filter-select"><span>区域</span><select value={nodeRegionFilter} onChange={(event) => setNodeRegionFilter(event.target.value)} aria-label="按区域筛选"><option value="all">全部</option>{regionFilterOptions.map((region) => <option key={region} value={region}>{region}</option>)}</select></label>
                  <label className="node-filter-select"><span>协议</span><select value={nodeProtocolFilter} onChange={(event) => setNodeProtocolFilter(event.target.value)} aria-label="按协议筛选"><option value="all">全部</option>{protocolFilterOptions.map((protocol) => <option key={protocol} value={protocol}>{protocol.toUpperCase()}</option>)}</select></label>
                  <label className="node-filter-select"><span>连通性</span><select value={nodeConnectivityFilter} onChange={(event) => setNodeConnectivityFilter(event.target.value)} aria-label="按连通性筛选"><option value="all">全部</option><option value="可用">可用</option><option value="测试失败">测试失败</option><option value="端口通">端口通</option><option value="不支持">不支持</option><option value="未测试">未测试</option></select></label>
                  <label className="node-filter-select"><span>延迟</span><select value={nodeLatencyFilter} onChange={(event) => setNodeLatencyFilter(event.target.value)} aria-label="按延迟筛选"><option value="all">全部</option><option value="lt-1000">小于 1000ms</option><option value="lt-2000">小于 2000ms</option><option value="lt-3000">小于 3000ms</option><option value="gt-3000">大于 3000ms</option><option value="gt-5000">大于 5000ms</option></select></label>
                  <button className="text-button node-filter-reset" type="button" onClick={resetNodeFilters} disabled={!nodeNameFilter && !nodeIpFilter && nodeRegionFilter === "all" && nodeProtocolFilter === "all" && nodeConnectivityFilter === "all" && nodeLatencyFilter === "all"} title="清空所有节点筛选">清空筛选</button>
                </div>
                <datalist id="node-region-options">
                  {REGION_OPTIONS.map((region) => <option key={region} value={region} />)}
                </datalist>
                <div className="node-list-table-scroll">
                  <div className="node-list-table">
                    <div className="node-list-head">
                      <label className="node-check"><input ref={selectAllRef} type="checkbox" checked={allNodesSelected} onChange={(event) => toggleAllNodes(event.target.checked)} aria-label="选择全部节点" /></label>
                      <span>#</span><span>节点名称</span><span>区域</span><span>协议</span><span>连通性</span><span>延迟</span><span>下载速度</span><span>服务器</span><span>来源</span><span>操作</span>
                    </div>
                    <div className="node-list-body">
                      {visibleNodeRows.length === 0 ? (
                        <div className="node-filter-empty">
                          <Filter size={20} />
                          <strong>没有匹配的节点</strong>
                          <span>调整筛选条件，或清空筛选后查看全部节点。</span>
                          <button className="secondary-button compact-button" type="button" onClick={resetNodeFilters}>清空筛选</button>
                        </div>
                      ) : null}
                      {visibleNodeRows.map((row, index) => {
                        const key = nodeKey(row.sourceId, row.nodeIndex);
                        const meta = (row.node as NodeWithMeta)._meta;
                        const connectivity = connectivityLabel(meta);
                        const isTesting = testingNodeKeys.has(key);
                        const isLatencyTesting = isTesting && testingMode === "latency";
                        const isSpeedTesting = isTesting && testingMode === "speed";
                        const proxyTestFailed = meta?.latencyTestStatus === "unavailable" || meta?.latencyTestStatus === "core-unavailable";
                        return (
                          <div className={`node-list-row${proxyTestFailed ? " node-list-row-error" : ""}`} key={key}>
                            <label className="node-check"><input type="checkbox" checked={selectedNodeKeys.has(key)} onChange={(event) => toggleNodeSelection(key, event.target.checked)} aria-label={`选择节点 ${index + 1}`} /></label>
                            <span className="node-list-index">{String(index + 1).padStart(2, "0")}</span>
                            <NodeNameEditor key={`name:${key}:${row.node.name}`} value={row.node.name} label={`节点 ${index + 1} 名称`} onCommit={(name) => renameNode(row.sourceId, row.nodeIndex, name)} />
                            <NodeRegionEditor
                              key={`region:${key}:${detectNodeRegion(row.node)}`}
                              value={detectNodeRegion(row.node)}
                              label={`节点 ${index + 1} 区域`}
                              hint={meta?.egressIp ? `实际出口 ${meta.egressIp}${meta.egressProvider ? ` · ${meta.egressProvider}` : ""}` : meta?.egressError}
                              onCommit={(region) => setNodeRegion(row.sourceId, row.nodeIndex, region)}
                            />
                            <span className="node-type">{row.node.type}</span>
                            <span className={`node-test-status node-test-${connectivity.tone}`} title={meta?.latencyTestError || meta?.testError || undefined}><i />{isLatencyTesting ? "测试中" : connectivity.label}</span>
                            <span className="node-test-value" title={meta?.latencyTestError || (meta?.tcpLatency ? `裸 TCP 建连延迟 ${meta.tcpLatency} ms` : undefined)}>{isLatencyTesting ? "…" : formatLatency(meta)}</span>
                            <span className="node-test-value" title={formatSpeedDetails(meta)}>{formatSpeed(meta, isSpeedTesting)}</span>
                            <span className="node-endpoint" title={`${String(row.node.server ?? "-")}:${String(row.node.port ?? "-")}`}>{String(row.node.server ?? "-")}:{String(row.node.port ?? "-")}</span>
                            <span className="node-source" title={row.sourceName}>{row.sourceName}</span>
                            <div className="node-row-actions">
                              <button className="icon-button compact" type="button" onClick={() => setViewingNodeKey(key)} title="查看节点详情" aria-label={`查看节点 ${index + 1} 全部信息`}><Eye size={14} /></button>
                              <button className="icon-button compact" type="button" onClick={() => void testRows([row], "latency")} disabled={testingNodeKeys.size > 0} title="测试连通性和延迟" aria-label={`测试节点 ${index + 1} 连通性和延迟`}><Activity size={14} /></button>
                              <button className="icon-button compact" type="button" onClick={() => void testRows([row], "speed")} disabled={testingNodeKeys.size > 0} title={`使用 ${speedTestConcurrency} 条并行流测试下载速度`} aria-label={`测试节点 ${index + 1} 下载速度`}><Gauge size={14} /></button>
                              <button className="icon-button compact danger-button" type="button" onClick={() => removeNodes(new Set([key]))} disabled={testingNodeKeys.size > 0} title="删除节点" aria-label={`删除节点 ${index + 1}`}><Trash2 size={14} /></button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {!output.error && allNodes.length > 0 && previewTab === "yaml" ? <YamlHighlight content={output.yaml} /> : null}
          </div>
        </section>
      </div>

      <footer className="app-footer" aria-label="应用状态">
        <div className="footer-mode">
          <span className="footer-status-dot" aria-hidden="true" />
          <strong>LOCAL FILE MODE</strong>
          <span>无数据库 · 文件化工作流</span>
        </div>
        <div className="footer-compatibility">
          <span>OUTPUT</span>
          <strong>FLCLASH / MIHOMO</strong>
        </div>
        <a href="https://github.com/SubBoost/subboost" target="_blank" rel="noreferrer">
          <Github size={13} />
          UPSTREAM SUBBOOST
        </a>
      </footer>

      {viewingNodeRow ? (
        <div
          className="node-detail-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setViewingNodeKey(null);
          }}
        >
          <section className="node-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="node-detail-title">
            <div className="node-detail-heading">
              <div>
                <span className="step-index">NODE {String(viewingNodeIndex + 1).padStart(2, "0")}</span>
                <h2 id="node-detail-title">{viewingNodeRow.node.name}</h2>
              </div>
              <button className="icon-button compact" type="button" title="关闭节点详情" aria-label="关闭节点详情" onClick={() => setViewingNodeKey(null)}><X size={17} /></button>
            </div>
            <div className="node-detail-meta">
              <span><strong>协议</strong>{String(viewingNodeRow.node.type || "-").toUpperCase()}</span>
              <span><strong>服务器</strong>{String(viewingNodeRow.node.server || "-")}:{String(viewingNodeRow.node.port || "-")}</span>
              <span><strong>来源</strong>{viewingNodeRow.sourceName}</span>
            </div>
            <pre className="node-detail-content"><code>{JSON.stringify(viewingNodeRow.node, null, 2)}</code></pre>
            <div className="node-detail-actions">
              <button className="accent-button" type="button" onClick={() => setViewingNodeKey(null)}>关闭</button>
            </div>
          </section>
        </div>
      ) : null}

      {baseYamlPreviewOpen ? (
        <div className="base-yaml-preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setBaseYamlPreviewOpen(false); }}>
          <section className="base-yaml-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="base-yaml-preview-title">
            <div className="base-yaml-preview-heading">
              <div>
                <span className="step-index">YAML</span>
                <h2 id="base-yaml-preview-title">基础配置 / DNS YAML</h2>
              </div>
              <button className="icon-button compact" type="button" title="关闭 YAML 查看窗口" aria-label="关闭 YAML 查看窗口" onClick={() => setBaseYamlPreviewOpen(false)}><X size={17} /></button>
            </div>
            <p className="base-yaml-preview-hint">语法高亮预览 · 当前窗口固定显示约 20 行，可滚动查看完整内容。</p>
            <div className="base-yaml-preview-content">
              <YamlHighlight content={template.baseConfigYaml.trim() || DEFAULT_BASE_CONFIG_YAML} />
            </div>
            <div className="base-yaml-preview-actions">
              <button className="accent-button" type="button" onClick={() => setBaseYamlPreviewOpen(false)}>关闭</button>
            </div>
          </section>
        </div>
      ) : null}

      {batchImportResult ? (
        <div className="batch-result-backdrop">
          <section className="batch-result-dialog" role="dialog" aria-modal="true" aria-labelledby="batch-result-title" aria-describedby="batch-result-description">
            <div className="batch-result-heading">
              <span className="step-index">导入结果</span>
              <h2 id="batch-result-title">订阅导入结果</h2>
              <p id="batch-result-description">请确认本次处理结果，确认后再继续处理需要人工审核的订阅。</p>
            </div>
            <div className="batch-result-summary" aria-label="批量导入统计">
              <div className="is-success"><span>导入成功</span><strong>{batchImportResult.successCount}</strong><small>条</small></div>
              <div className="is-failure"><span>导入失败</span><strong>{batchImportResult.failureCount}</strong><small>条</small></div>
              <div className="is-review"><span>待人工确认</span><strong>{batchImportResult.reviewCount}</strong><small>条</small></div>
            </div>
            {batchImportResult.duplicateCount > 0 ? <div className="batch-result-duplicates">已自动忽略 {batchImportResult.duplicateCount} 条重复链接</div> : null}
            {batchImportResult.failures.length > 0 ? (
              <div className="batch-result-failures">
                <strong>失败明细</strong>
                <ul>
                  {batchImportResult.failures.map((failure, index) => (
                    <li key={`${failure.url}-${index}`}><span>{failure.url}</span><small>{failure.error}</small></li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="batch-result-actions">
              <span>{batchImportResult.reviewCount > 0 ? `确认后将继续审核 ${batchImportResult.reviewCount} 条订阅` : "本批次无需后续人工审核"}</span>
              <button className="accent-button" type="button" autoFocus onClick={() => setBatchImportResult(null)}>确认结果</button>
            </div>
          </section>
        </div>
      ) : null}

      {!batchImportResult && pendingTlsReview ? (
        <div className="tls-review-backdrop">
          <section className="tls-review-dialog" role="dialog" aria-modal="true" aria-labelledby="tls-review-title">
            <div className="tls-review-heading">
              <div>
                <span className="step-index">审核</span>
                <h2 id="tls-review-title">证书校验未通过</h2>
              </div>
              <button className="icon-button compact" type="button" title="放弃当前审核" aria-label="放弃当前审核" onClick={advanceTlsReview}>×</button>
            </div>
            <div className="tls-review-warning">
              <CircleAlert size={19} />
              <div>
                <strong>以下内容通过了 YAML 和节点解析，但来源连接不受可信证书保护。</strong>
                <span>{pendingTlsReview.reason}</span>
              </div>
            </div>
            <div className="tls-review-meta">
              <span>候选节点 <strong>{pendingTlsReview.nodes.length}</strong></span>
              <span>解析提示 <strong>{pendingTlsReview.errors.length}</strong></span>
              <span>待审核 <strong>{pendingTlsReviews.length}</strong></span>
              <span className="tls-review-url" title={pendingTlsReview.url}>{pendingTlsReview.url}</span>
            </div>
            <div className="tls-review-preview-bar">
              <span>{showDecodedReview ? "解码明文" : "Base64 原文"}</span>
              <button
                className="secondary-button compact-button"
                type="button"
                aria-pressed={showDecodedReview}
                disabled={!decodedReviewContent}
                title={decodedReviewContent ? "切换审核内容的显示方式" : "返回内容不是可解码的 Base64 文本"}
                onClick={() => setShowDecodedReview((current) => !current)}
              >
                <Code2 size={15} />{showDecodedReview ? "显示原文" : "显示明文"}
              </button>
            </div>
            <pre className="tls-review-content"><code>{reviewPreview}</code></pre>
            <div className="tls-review-actions">
              <button className="secondary-button" type="button" onClick={advanceTlsReview}>放弃当前项</button>
              <button className="accent-button" type="button" onClick={() => void confirmTlsReview()} disabled={busy}>确认加入来源</button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
