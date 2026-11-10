import { parseSubscription } from "@subboost/core/parser";
import {
  hasClientUpdatePlaceholderError,
  looksLikeClientUpdatePlaceholderNodes,
} from "@subboost/core/parser/placeholder";
import {
  createSubscriptionImportErrorInfo,
  inferSubscriptionImportErrorCategory,
  sanitizePublicErrorText,
  type SubscriptionImportErrorInfo,
} from "@subboost/core/subscription/import-error";
import { tryNormalizeSubscriptionUrlInput } from "@subboost/core/subscription/url-input";
import type { ParseResult, ParsedNode } from "@subboost/core/types/node";
import { SUBSCRIPTION_IMPORT_USER_AGENTS } from "./user-agents";

export type SourceImportPurpose = "content" | "userinfo";

export type SourceImportTransportRequest = {
  url: string;
  userAgent: string;
  purpose: SourceImportPurpose;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
};

export type SourceImportTransportResult = {
  ok: boolean;
  content?: string;
  headers?: Record<string, string>;
  error?: string;
  errorInfo?: SubscriptionImportErrorInfo | null;
  responseStatus?: number;
  publicReason?: string | null;
};

export type SourceImportRequest = {
  url: string;
  userinfoUrl?: string;
  userinfoUserAgent?: string;
};

export type SourceImportSuccess = {
  ok: true;
  content: string;
  headers: Record<string, string>;
  parsedNodes: ParsedNode[];
  parseErrors: string[];
  directDomains?: ParseResult["directDomains"];
  baseConfigYaml?: string;
};

export type SourceImportFailure = {
  ok: false;
  error: string;
  errorInfo: SubscriptionImportErrorInfo;
  responseStatus?: number;
  publicReason?: string | null;
};

export type SourceImportResult = SourceImportSuccess | SourceImportFailure;

export function buildSourceImportParseResult(
  result: Pick<SourceImportSuccess, "parsedNodes" | "parseErrors">
): ParseResult {
  const nodes = result.parsedNodes;
  const errors = result.parseErrors;
  return {
    nodes,
    errors,
    totalParsed: nodes.length,
    totalFailed: errors.length,
  };
}

type ParsedAttempt =
  | {
      ok: true;
      userAgent: string;
      content: string;
      headers: Record<string, string>;
      parsed: ParseResult;
    }
  | {
      ok: false;
      userAgent: string;
      error: string;
      errorInfo?: SubscriptionImportErrorInfo | null;
      responseStatus?: number;
      publicReason?: string | null;
    };

function createErrorInfo(message: string, httpStatus?: number): SubscriptionImportErrorInfo {
  return createSubscriptionImportErrorInfo({
    category: inferSubscriptionImportErrorCategory(message),
    message,
    detail: message,
    httpStatus,
  });
}

function isUsableParsedAttempt(attempt: ParsedAttempt): attempt is Extract<ParsedAttempt, { ok: true }> {
  return attempt.ok && attempt.parsed.nodes.length > 0 && !looksLikeClientUpdatePlaceholderNodes(attempt.parsed.nodes);
}

function toFailure(attempt: ParsedAttempt | null, fallback = "获取 url 失败"): SourceImportFailure {
  if (!attempt) {
    return {
      ok: false,
      error: fallback,
      errorInfo: createErrorInfo(fallback),
    };
  }

  if (!attempt.ok) {
    const message = sanitizePublicErrorText(attempt.error) || fallback;
    return {
      ok: false,
      error: message,
      errorInfo: attempt.errorInfo ?? createErrorInfo(message, attempt.responseStatus),
      responseStatus: attempt.responseStatus,
      publicReason: attempt.publicReason ?? null,
    };
  }

  const parseError = attempt.parsed.errors[0] || "未解析到有效节点";
  const message = hasClientUpdatePlaceholderError(attempt.parsed.errors) ||
    looksLikeClientUpdatePlaceholderNodes(attempt.parsed.nodes)
    ? "订阅服务返回了客户端更新提示占位内容，未导入该结果"
    : parseError;
  return {
    ok: false,
    error: message,
    errorInfo: createSubscriptionImportErrorInfo({
      category: "parse",
      message,
      detail: parseError,
    }),
  };
}

function pickBetterAttempt(current: ParsedAttempt | null, next: ParsedAttempt): ParsedAttempt {
  if (!current) return next;
  const currentUsable = isUsableParsedAttempt(current);
  const nextUsable = isUsableParsedAttempt(next);
  if (currentUsable !== nextUsable) return nextUsable ? next : current;
  if (current.ok !== next.ok) return next.ok ? next : current;
  if (!current.ok || !next.ok) return current;
  if (current.parsed.nodes.length !== next.parsed.nodes.length) {
    return next.parsed.nodes.length > current.parsed.nodes.length ? next : current;
  }
  if (current.parsed.errors.length !== next.parsed.errors.length) {
    return next.parsed.errors.length < current.parsed.errors.length ? next : current;
  }
  return current;
}

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const normalizedKey = key.toLowerCase().trim();
    if (!normalizedKey || typeof value !== "string") continue;
    out[normalizedKey] = value;
  }
  return out;
}

async function fetchAndParseWithUserAgent(
  url: string,
  userAgent: string,
  options: {
    timeoutMs: number;
    maxBytes: number;
    fetchText: (request: SourceImportTransportRequest) => Promise<SourceImportTransportResult>;
  }
): Promise<ParsedAttempt> {
  const response = await options.fetchText({
    url,
    userAgent,
    purpose: "content",
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
  });
  if (!response.ok || typeof response.content !== "string") {
    const message = sanitizePublicErrorText(response.error) || "获取 url 失败";
    return {
      ok: false,
      userAgent,
      error: message,
      errorInfo: response.errorInfo,
      responseStatus: response.responseStatus,
      publicReason: response.publicReason ?? null,
    };
  }

  return {
    ok: true,
    userAgent,
    content: response.content,
    headers: normalizeHeaders(response.headers),
    parsed: parseSubscription(response.content),
  };
}

async function fetchSupplementalUserInfoHeaders(
  request: SourceImportRequest,
  options: {
    timeoutMs: number;
    maxBytes: number;
    fetchText: (request: SourceImportTransportRequest) => Promise<SourceImportTransportResult>;
  },
  fallbackUrl: string
): Promise<Record<string, string>> {
  if (!request.userinfoUrl && !request.userinfoUserAgent) return {};
  const rawUrl = request.userinfoUrl || fallbackUrl;
  const url = tryNormalizeSubscriptionUrlInput(rawUrl);
  if (!url) return {};
  const response = await options.fetchText({
    url,
    userAgent: request.userinfoUserAgent?.trim() || SUBSCRIPTION_IMPORT_USER_AGENTS[0],
    purpose: "userinfo",
    timeoutMs: Math.min(options.timeoutMs, 8000),
    maxBytes: options.maxBytes,
  });
  return response.ok ? normalizeHeaders(response.headers) : {};
}

export async function importSubscriptionFromUrl(
  request: SourceImportRequest,
  options: {
    timeoutMs?: number;
    maxBytes?: number;
    userAgents?: readonly string[];
    signal?: AbortSignal;
    fetchText: (request: SourceImportTransportRequest) => Promise<SourceImportTransportResult>;
  }
): Promise<SourceImportResult> {
  const url = tryNormalizeSubscriptionUrlInput(request.url);
  if (!url) {
    return {
      ok: false,
      error: "无效的 url 格式",
      errorInfo: createSubscriptionImportErrorInfo({
        category: "format",
        message: "无效的 url 格式",
      }),
    };
  }
  const parsedUrl = new URL(url);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return {
      ok: false,
      error: "只支持 HTTP/HTTPS url",
      errorInfo: createSubscriptionImportErrorInfo({
        category: "format",
        message: "只支持 HTTP/HTTPS url",
      }),
    };
  }

  const timeoutMs = options.timeoutMs ?? 15000;
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const userAgents = options.userAgents?.length ? options.userAgents : SUBSCRIPTION_IMPORT_USER_AGENTS;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const timers: ReturnType<typeof setTimeout>[] = [];
  timers.push(setTimeout(() => controller.abort(), timeoutMs));
  const wait = (ms: number) => new Promise<void>((resolve) => timers.push(setTimeout(resolve, ms)));
  const timedOut = (): SourceImportTransportResult => ({ ok: false, error: "订阅抓取超时", publicReason: "订阅抓取超时" });

  // long: DNS、格式补试和附加信息共用一个截止时间；即使底层不响应取消，也必须释放当前导入 worker。
  const fetchText = (transportRequest: SourceImportTransportRequest): Promise<SourceImportTransportResult> =>
    new Promise((resolve) => {
      if (signal.aborted) { resolve(timedOut()); return; }
      const finish = (result: SourceImportTransportResult) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => finish(timedOut());
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve().then(() => options.fetchText({ ...transportRequest, signal })).then(finish, (error: unknown) => {
        const message = sanitizePublicErrorText(error instanceof Error ? error.message : String(error)) || "获取 url 失败";
        finish({ ok: false, error: message });
      });
    });

  try {
    const attempts: Array<ParsedAttempt | undefined> = new Array(userAgents.length);
    let notifyUsable: () => void = () => undefined;
    const firstUsable = new Promise<void>((resolve) => { notifyUsable = resolve; });
    const fetchAttempt = async (index: number) => {
      const attempt = await fetchAndParseWithUserAgent(url, userAgents[index], { timeoutMs, maxBytes, fetchText });
      attempts[index] = attempt;
      if (isUsableParsedAttempt(attempt)) notifyUsable();
    };
    const initial = Promise.all(userAgents.slice(0, 2).map((_, index) => fetchAttempt(index)));
    const supplementalAttempts = async () => {
      if (userAgents.length <= 2) return;
      // long: 两个客户端都迟迟不给结果时，浏览器格式提前补试，避免等满期限后才发现可用内容。
      await Promise.race([initial, wait(1500)]);
      if (signal.aborted || attempts.some((attempt) => attempt && isUsableParsedAttempt(attempt) && attempt.parsed.errors.length === 0)) return;
      await Promise.all(userAgents.slice(2).map((_, index) => fetchAttempt(index + 2)));
    };
    // long: 得到可用节点后最多再等 750ms 比较完整度，慢格式不能拖丢已经成功的明文/Base64 结果。
    await Promise.race([Promise.all([initial, supplementalAttempts()]), firstUsable.then(() => wait(750))]);
    let best: ParsedAttempt | null = null;
    for (const attempt of attempts) if (attempt) best = pickBetterAttempt(best, attempt);
    if (!best || !isUsableParsedAttempt(best)) return toFailure(best);

    const supplementalHeaders = await fetchSupplementalUserInfoHeaders(request, { timeoutMs, maxBytes, fetchText }, url);
    return {
      ok: true,
      content: best.content,
      headers: { ...best.headers, ...supplementalHeaders },
      parsedNodes: best.parsed.nodes,
      parseErrors: best.parsed.errors,
      ...(best.parsed.directDomains ? { directDomains: best.parsed.directDomains } : {}),
      ...(best.parsed.baseConfigYaml ? { baseConfigYaml: best.parsed.baseConfigYaml } : {}),
    };
  } finally {
    controller.abort();
    timers.forEach(clearTimeout);
  }
}
