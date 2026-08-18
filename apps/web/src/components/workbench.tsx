"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Braces,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Clipboard,
  Cloud,
  Code2,
  Download,
  FileJson,
  FileUp,
  Gauge,
  Github,
  Link2,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Network,
  Plus,
  SlidersHorizontal,
  ShieldCheck,
  Trash2,
  Upload,
  WandSparkles,
} from "lucide-react";
import { generateClashConfig, generateClashYaml } from "@subboost/core/generator";
import { PROXY_GROUP_MODULES } from "@subboost/core/generator/proxy-groups";
import { parseBase64, parseSubscription } from "@subboost/core/parser";
import { RULE_PROVIDER_SOURCES } from "@subboost/core/rules/metadata";
import type { BuiltinRuleEdits, ClashConfig, InternalDomainRule, TemplateType } from "@subboost/core/types/config";
import type { NodeWithMeta, ParsedNode } from "@subboost/core/types/node";
import { YamlHighlight } from "@/components/yaml-highlight";
import {
  formatSubscriptionImportFailures,
  parseSubscriptionUrlBatch,
  runSubscriptionImportWithTimeout,
  SUBSCRIPTION_IMPORT_TIMEOUT_MESSAGE,
} from "@/lib/batch-import";
import {
  ADRULES_MIHOMO_URL,
  createBuiltinTemplate,
  type LiteTemplate,
  parseLiteTemplate,
  REQUIRED_MODULES,
  safeFileName,
} from "@/lib/lite-template";
import { buildRegionNodeNames, countryCodeToRegion, detectNodeRegion } from "@/lib/node-region";
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
  | { ok: true; reviewRequired: false; content: string; nodes: ParsedNode[]; errors: string[] }
  | { ok: true; reviewRequired: true; reviewReason: string; content: string; nodes: ParsedNode[]; errors: string[] }
  | { ok: false; error: string; detail?: string | null };

type PendingTlsReview = {
  url: string;
  reason: string;
  content: string;
  nodes: ParsedNode[];
  errors: string[];
};

type UrlImportOutcome =
  | { status: "ready"; url: string; content: string; nodes: ParsedNode[]; errors: string[] }
  | { status: "review"; review: PendingTlsReview }
  | { status: "failed"; url: string; error: string };

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
      internalDomains: template.internalDomains,
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

const REGION_OPTIONS = ["香港", "澳门", "台湾", "日本", "韩国", "新加坡", "美国", "加拿大", "英国", "德国", "法国", "澳大利亚", "印度", "俄罗斯", "中国大陆", "其他"];

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
        className="node-region-input"
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

export function Workbench() {
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [sourceKind, setSourceKind] = useState<SourceKind>("url");
  const [sourceInput, setSourceInput] = useState("");
  const [template, setTemplate] = useState<LiteTemplate>(() => createBuiltinTemplate("standard"));
  const [previewTab, setPreviewTab] = useState<PreviewTab>("visual");
  const [busy, setBusy] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selectedNodeKeys, setSelectedNodeKeys] = useState<Set<string>>(() => new Set());
  const [testingNodeKeys, setTestingNodeKeys] = useState<Set<string>>(() => new Set());
  const [testingMode, setTestingMode] = useState<NodeTestMode | null>(null);
  const [connectivityTimeoutSeconds, setConnectivityTimeoutSeconds] = useState(3.5);
  const [speedTestDurationSeconds, setSpeedTestDurationSeconds] = useState(15);
  const [speedTestConcurrency, setSpeedTestConcurrency] = useState(10);
  const [speedTestSource, setSpeedTestSource] = useState<SpeedTestSource>("cloudflare");
  const [speedTestCustomUrl, setSpeedTestCustomUrl] = useState("");
  const [speedTestMaxDataMb, setSpeedTestMaxDataMb] = useState(300);
  const [pendingTlsReviews, setPendingTlsReviews] = useState<PendingTlsReview[]>([]);
  const pendingTlsReview = pendingTlsReviews[0] ?? null;
  const [showDecodedReview, setShowDecodedReview] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const yamlFileRef = useRef<HTMLInputElement>(null);
  const templateFileRef = useRef<HTMLInputElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    handleFullscreenChange();
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (!pendingTlsReview) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowDecodedReview(false);
        setPendingTlsReviews((current) => current.slice(1));
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [pendingTlsReview]);

  const nodeRows = useMemo<NodeRow[]>(() => sources.flatMap((source) => source.nodes.map((node, nodeIndex) => ({
    sourceId: source.id,
    sourceName: source.name,
    nodeIndex,
    node,
  }))), [sources]);
  const selectedRows = useMemo(
    () => nodeRows.filter((row) => selectedNodeKeys.has(nodeKey(row.sourceId, row.nodeIndex))),
    [nodeRows, selectedNodeKeys]
  );
  const failedNodeKeys = useMemo(() => new Set(nodeRows
    // long: 仅删除代理探测确认不可用的节点；内核不可用属于测试环境故障，不能据此批量清理用户节点。
    .filter((row) => (row.node as NodeWithMeta)._meta?.latencyTestStatus === "unavailable")
    .map((row) => nodeKey(row.sourceId, row.nodeIndex))), [nodeRows]);
  const allNodesSelected = nodeRows.length > 0 && selectedRows.length === nodeRows.length;
  const someNodesSelected = selectedRows.length > 0 && !allNodesSelected;
  const allNodes = useMemo(() => nodeRows.map((row) => row.node), [nodeRows]);
  const output = useMemo(() => buildOutput(allNodes, template), [allNodes, template]);
  const groups = (output.config?.["proxy-groups"] ?? []) as Array<{
    name: string;
    type: string;
    proxies?: string[];
  }>;
  const ruleCount = PROXY_GROUP_MODULES
    .filter((module) => template.enabledModules.includes(module.id))
    .reduce((total, module) => total + module.rules.length, 0) +
    (template.adRuleMode === "enhanced" && template.enabledModules.includes("ad") ? 1 : 0) +
    template.internalDomains.length;
  const categories = [...new Set(PROXY_GROUP_MODULES.map((module) => module.category))];
  const providerSourceId = getProviderSourceId(template.ruleProviderBaseUrl);
  const decodedReviewContent = useMemo(
    () => pendingTlsReview ? decodeReviewBase64(pendingTlsReview.content) : null,
    [pendingTlsReview]
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
    const renamedNodes = buildRegionNodeNames(nodeRows);
    const nameByPosition = new Map(renamedNodes.map((item) => [`${item.sourceId}:${item.nodeIndex}`, item.name]));

    // long: 批量命名在一次状态更新中完成，避免中途生成包含一半新名称、一半旧名称的配置预览。
    setSources((current) => current.map((source) => ({
      ...source,
      nodes: source.nodes.map((node, nodeIndex) => ({
        ...node,
        name: nameByPosition.get(`${source.id}:${nodeIndex}`) ?? node.name,
      })),
    })));
    showNotice("ok", `已按区域重命名 ${renamedNodes.length} 个节点`);
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
    setSelectedNodeKeys(checked ? new Set(nodeRows.map((row) => nodeKey(row.sourceId, row.nodeIndex))) : new Set());
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

  function addParsedSource(
    kind: SourceKind,
    content: string,
    nodes: ParsedNode[],
    errors: string[],
    name?: string,
    options: { preserveInput?: boolean } = {}
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
    showNotice("ok", `已导入 ${nodes.length} 个节点`);
  }

  async function confirmTlsReview() {
    if (!pendingTlsReview) return;
    const review = pendingTlsReview;
    setBusy(true);
    try {
      // long: 批量失败链接仍保留在输入框中，审核通过不能顺带清除用户下一步需要重试的内容。
      await addParsedSource("url", review.content, review.nodes, review.errors, sourceName("url", review.url, sources.length + 1), { preserveInput: true });
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
        if (parsed.nodes.length === 0) {
          showNotice("error", parsed.errors[0] || "未识别到有效节点");
          return;
        }
        await addParsedSource(sourceKind, value, parsed.nodes, parsed.errors);
        return;
      }

      const { urls, duplicateCount } = parseSubscriptionUrlBatch(value);
      if (urls.length === 0) {
        showNotice("error", "请输入至少一个订阅链接");
        return;
      }

      // long: 每条请求自行收敛为成功、待审核或失败，单个订阅异常不能中断同批其他链接。
      const outcomes = await Promise.all(urls.map(async (url): Promise<UrlImportOutcome> => {
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
          if (!result.ok) return { status: "failed", url, error: result.detail || result.error };
          if (result.reviewRequired) {
            return {
              status: "review",
              review: {
                url,
                reason: result.reviewReason,
                content: result.content,
                nodes: result.nodes,
                errors: result.errors,
              },
            };
          }
          return { status: "ready", url, content: result.content, nodes: result.nodes, errors: result.errors };
        } catch (error) {
          return { status: "failed", url, error: error instanceof Error ? error.message : "订阅链接导入失败" };
        }
      }));

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

      setSourceInput(failures.map((item) => item.url).join("\n"));
      setShowDecodedReview(false);
      setPendingTlsReviews(reviewQueue);

      const summary = [
        `${readyOutcomes.length} 个已导入`,
        `${reviewQueue.length} 个待审核`,
        `${failures.length} 个失败`,
        ...(duplicateCount > 0 ? [`忽略 ${duplicateCount} 个重复链接`] : []),
      ].join(" · ");
      const singleFailure = urls.length === 1 && failures.length === 1 && readyOutcomes.length === 0 && reviewQueue.length === 0;
      if (singleFailure) {
        showNotice("error", failures[0].error === SUBSCRIPTION_IMPORT_TIMEOUT_MESSAGE
          ? SUBSCRIPTION_IMPORT_TIMEOUT_MESSAGE
          : `导入失败：${formatSubscriptionImportFailures(failures)}`);
      } else {
        const failureDetail = failures.length > 0 ? `；失败链接已保留；失败：${formatSubscriptionImportFailures(failures)}` : "";
        showNotice(reviewQueue.length > 0 || failures.length > 0 ? "error" : "ok", `批量处理完成：${summary}${failureDetail}`);
      }
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : "订阅链接导入失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleYamlFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const content = await file.text();
      const parsed = parseSubscription(content);
      if (parsed.nodes.length === 0) {
        showNotice("error", parsed.errors[0] || "YAML 中没有可用节点");
        return;
      }
      await addParsedSource("yaml", content, parsed.nodes, parsed.errors, file.name);
    } catch (error) {
      showNotice("error", error instanceof Error ? error.message : "YAML 文件导入失败");
    } finally {
      setBusy(false);
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

  function addInternalDomain() {
    setTemplate((current) => ({
      ...current,
      internalDomains: [...current.internalDomains, { domain: "", nameservers: [] }],
    }));
  }

  function updateInternalDomain(index: number, patch: Partial<InternalDomainRule>) {
    setTemplate((current) => ({
      ...current,
      internalDomains: current.internalDomains.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
    }));
  }

  function removeInternalDomain(index: number) {
    setTemplate((current) => ({
      ...current,
      internalDomains: current.internalDomains.filter((_, itemIndex) => itemIndex !== index),
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
    downloadText(
      `${JSON.stringify(template, null, 2)}\n`,
      `${safeFileName(template.name)}.template.json`,
      "application/json;charset=utf-8"
    );
  }

  function downloadConfig() {
    if (!output.yaml) return;
    downloadText(output.yaml, `${safeFileName(template.name)}.yaml`, "text/yaml;charset=utf-8");
  }

  async function copyYaml() {
    if (!output.yaml) return;
    await navigator.clipboard.writeText(output.yaml);
    showNotice("ok", "配置已复制");
  }

  return (
    <main className="app-shell">
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
          <span><strong>{template.enabledModules.length}</strong> 分组</span>
        </div>
        <div className="topbar-actions">
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

      {notice ? <div className={`notice notice-${notice.tone}`}><span>{notice.tone === "ok" ? <Check size={16} /> : <CircleAlert size={16} />}</span>{notice.text}</div> : null}

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
                onClick={() => {
                  if (kind === sourceKind) return;
                  // long: 三种输入格式不能互相复用，切换来源时清空旧文本，避免把订阅 URL 当作 YAML 或节点链接解析。
                  setSourceKind(kind);
                  setSourceInput("");
                }}
              >
                {kind === "url" ? <Link2 size={15} /> : kind === "yaml" ? <Code2 size={15} /> : <Network size={15} />}
                {SOURCE_META[kind].label}
              </button>
            ))}
          </div>

          {sourceKind === "url" ? (
            <textarea className="source-input source-input-urls" value={sourceInput} onChange={(event) => setSourceInput(event.target.value)} placeholder={SOURCE_META.url.placeholder} spellCheck={false} />
          ) : (
            <textarea className="source-input" value={sourceInput} onChange={(event) => setSourceInput(event.target.value)} placeholder={SOURCE_META[sourceKind].placeholder} spellCheck={false} />
          )}

          <div className="source-actions">
            {sourceKind === "yaml" ? (
              <>
                <input ref={yamlFileRef} className="sr-only" type="file" accept=".yaml,.yml,text/yaml,application/yaml" onChange={(event) => { void handleYamlFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
                <button className="secondary-button" type="button" onClick={() => yamlFileRef.current?.click()}><FileUp size={16} />选择文件</button>
              </>
            ) : <span />}
            <button className="accent-button" type="button" onClick={() => void handleAddSource()} disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
              {busy ? "导入中" : sourceKind === "url" ? "批量导入" : "加入来源"}
            </button>
          </div>

          <div className="source-list">
            {sources.length === 0 ? (
              <div className="empty-state"><Upload size={22} /><span>等待导入</span></div>
            ) : sources.map((source, index) => (
              <article className="source-item" key={source.id}>
                <div className="source-order">{String(index + 1).padStart(2, "0")}</div>
                <div className="source-info">
                  <strong>{source.name}</strong>
                  <span>{SOURCE_META[source.kind].label} · {source.nodes.length} 节点{source.errors.length ? ` · ${source.errors.length} 条提示` : ""}</span>
                </div>
                <button className="icon-button compact" type="button" title="移除来源" disabled={testingNodeKeys.size > 0} onClick={() => removeSource(source.id)}><Trash2 size={15} /></button>
              </article>
            ))}
          </div>
        </section>

        <section className="panel template-panel" aria-labelledby="template-title">
          <div className="panel-heading">
            <div><span className="step-index">02</span><h2 id="template-title">规则模板</h2></div>
            <div className="heading-actions">
              <input ref={templateFileRef} className="sr-only" type="file" accept=".json,application/json" onChange={(event) => { void handleTemplateFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
              <button className="icon-button compact" type="button" title="导入模板文件" onClick={() => templateFileRef.current?.click()}><FileUp size={15} /></button>
              <button className="icon-button compact" type="button" title="导出模板文件" onClick={exportTemplate}><FileJson size={15} /></button>
            </div>
          </div>

          <div className="template-presets">
            {(["minimal", "standard", "full"] as TemplateType[]).map((type) => {
              const labels: Record<TemplateType, string> = { minimal: "轻量", standard: "日常", full: "高级" };
              return <button key={type} type="button" className={template.baseTemplate === type && !template.name.endsWith("· 自定义") ? "active" : ""} onClick={() => applyBuiltin(type)}>{labels[type]}</button>;
            })}
          </div>
          <p className="template-description">{template.description}</p>

          <label className="field-label" htmlFor="template-name">模板名称</label>
          <input id="template-name" className="form-control" value={template.name} onChange={(event) => setTemplate((current) => ({ ...current, name: event.target.value }))} />

          <div className="optimization-settings" aria-label="规则优化设置">
            <div className="optimization-heading"><span><Cloud size={14} />下载与规则策略</span><small>适配 FlClash / Mihomo</small></div>
            <label className="field-label" htmlFor="provider-source">规则集下载源</label>
            <select
              id="provider-source"
              className="form-control"
              value={providerSourceId}
              onChange={(event) => {
                const source = event.target.value as keyof typeof RULE_PROVIDER_SOURCES | "custom";
                if (source === "custom") {
                  setTemplate((current) => ({ ...current, ruleProviderBaseUrl: "https://rules.example.com/geo" }));
                  return;
                }
                setTemplate((current) => ({ ...current, ruleProviderBaseUrl: RULE_PROVIDER_SOURCES[source].baseUrl }));
              }}
            >
              {(Object.entries(RULE_PROVIDER_SOURCES) as Array<[
                keyof typeof RULE_PROVIDER_SOURCES,
                { label: string; baseUrl: string }
              ]>).map(([id, source]) => <option key={id} value={id}>{source.label}</option>)}
              <option value="custom">自定义 URL 前缀</option>
            </select>
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
            <label className="switch-field optimization-switch"><span>国内域名增强</span><input type="checkbox" checked={template.experimentalCnUseCnRuleSet} onChange={(event) => setTemplate((current) => ({ ...current, experimentalCnUseCnRuleSet: event.target.checked }))} /><i /></label>
          </div>

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

          <details className="advanced-settings">
            <summary><SlidersHorizontal size={15} />基础配置<ChevronRight size={15} /></summary>
            <div className="advanced-body">
              <div className="field-row">
                <label><span>Mixed 端口</span><input className="form-control" type="number" min="1" max="65535" value={template.mixedPort} onChange={(event) => setTemplate((current) => ({ ...current, mixedPort: Number(event.target.value) }))} /></label>
                <label className="switch-field"><span>允许局域网</span><input type="checkbox" checked={template.allowLan} onChange={(event) => setTemplate((current) => ({ ...current, allowLan: event.target.checked }))} /><i /></label>
              </div>
              <div className="internal-domain-settings">
                <div className="internal-domain-heading">
                  <div>
                    <span className="field-label">内网域名直连</span>
                    <small>生成 Fake-IP 过滤、指定 DNS 和 DOMAIN-SUFFIX 直连规则</small>
                  </div>
                  <button className="secondary-button compact-button" type="button" onClick={addInternalDomain}><Plus size={14} />添加域名</button>
                </div>
                {template.internalDomains.length === 0 ? (
                  <div className="internal-domain-empty">暂无内网域名，留空不改变默认 DNS 行为。</div>
                ) : (
                  <div className="internal-domain-list">
                    {template.internalDomains.map((item, index) => (
                      <div className="internal-domain-row" key={`internal-domain-${index}`}>
                        <input
                          className="form-control"
                          value={item.domain}
                          onChange={(event) => updateInternalDomain(index, { domain: event.target.value })}
                          placeholder="例如 intranet.example.com"
                          aria-label={`内网域名 ${index + 1}`}
                        />
                        <input
                          className="form-control"
                          value={item.nameservers.join(", ")}
                          onChange={(event) => updateInternalDomain(index, { nameservers: event.target.value.split(/[\\s,;，；]+/).map((entry) => entry.trim()).filter(Boolean) })}
                          placeholder="DNS 地址，逗号分隔"
                          aria-label={`内网域名 ${index + 1} 的 DNS 地址`}
                        />
                        <button className="icon-button compact" type="button" title="删除内网域名" onClick={() => removeInternalDomain(index)}><Trash2 size={14} /></button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <label className="field-label" htmlFor="base-yaml">基础和 DNS YAML 覆盖</label>
              <textarea id="base-yaml" className="base-yaml" spellCheck={false} value={template.baseConfigYaml} onChange={(event) => setTemplate((current) => ({ ...current, baseConfigYaml: event.target.value }))} placeholder="留空使用内置安全配置" />
            </div>
          </details>
        </section>

        <section className="panel preview-panel" aria-labelledby="preview-title">
          <div className="preview-toolbar">
            <div><span className="step-index">03</span><h2 id="preview-title">配置预览</h2></div>
            <div className="preview-actions">
              <button className="icon-button compact" type="button" title="复制 YAML" onClick={() => void copyYaml()} disabled={!output.yaml}><Clipboard size={15} /></button>
              <button className="secondary-button compact-button" type="button" onClick={downloadConfig} disabled={!output.yaml}><Download size={15} />YAML</button>
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
            {!output.error && allNodes.length === 0 ? <div className="preview-empty"><Network size={30} /><strong>尚未生成配置</strong><span>导入任意来源后自动更新</span></div> : null}
            {!output.error && allNodes.length > 0 && previewTab === "visual" ? (
              <div className="node-list-view">
                <div className="node-list-toolbar">
                  <div>
                    <strong>节点列表</strong>
                    <span>名称与区域可直接编辑 · 选中 {selectedRows.length} 个</span>
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
                      <button className="secondary-button compact-button" type="button" onClick={() => void testRows(selectedRows, "latency")} disabled={testingNodeKeys.size > 0 || selectedRows.length === 0} title="测试选中节点的连通性和代理延迟">
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
                      <button className="secondary-button compact-button" type="button" onClick={() => void testRows(selectedRows, "speed")} disabled={testingNodeKeys.size > 0 || selectedRows.length === 0} title={`使用 ${speedTestConcurrency} 条并行下载流测试选中节点，采样上限 ${speedTestMaxDataMb} MB`}>
                        {testingNodeKeys.size > 0 && testingMode === "speed" ? <LoaderCircle className="spin" size={15} /> : <Gauge size={15} />}测速
                      </button>
                    </div>
                    <button className="secondary-button compact-button danger-button" type="button" onClick={() => removeNodes(selectedNodeKeys)} disabled={testingNodeKeys.size > 0 || selectedRows.length === 0} title="删除选中的节点">
                      <Trash2 size={15} />删除选中
                    </button>
                    <button className="secondary-button compact-button danger-button" type="button" onClick={() => removeNodes(failedNodeKeys, "测试失败的")} disabled={testingNodeKeys.size > 0 || failedNodeKeys.size === 0} title="删除所有代理连通/延迟测试失败的节点">
                      <Trash2 size={15} />删除失败 ({failedNodeKeys.size})
                    </button>
                    <button className="secondary-button compact-button" type="button" onClick={renameNodesByRegion} disabled={testingNodeKeys.size > 0} title="根据节点区域批量命名">
                      <WandSparkles size={15} />按区域命名
                    </button>
                  </div>
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
                      {nodeRows.map((row, index) => {
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
                            <NodeNameEditor key={`${key}-${row.node.name}`} value={row.node.name} label={`节点 ${index + 1} 名称`} onCommit={(name) => renameNode(row.sourceId, row.nodeIndex, name)} />
                            <NodeRegionEditor
                              key={`${key}-${detectNodeRegion(row.node)}`}
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

      {pendingTlsReview ? (
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
