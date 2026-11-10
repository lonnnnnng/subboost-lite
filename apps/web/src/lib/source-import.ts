import {
  createSubscriptionImportErrorInfo,
  inferSubscriptionImportErrorCategory,
  sanitizePublicErrorText,
} from "@subboost/core/subscription/import-error";
import {
  importSubscriptionFromUrl,
  SUBSCRIPTION_IMPORT_USER_AGENTS,
  type SourceImportRequest,
  type SourceImportResult,
  type SourceImportTransportRequest,
  type SourceImportTransportResult,
} from "@subboost/server-core/subscription";
import { requestPinnedText, ResponseTooLargeError, type DirectHttpResponse } from "./pinned-http";
import { resolvePublicHost } from "./public-host";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const USERINFO_TIMEOUT_MS = 8000;
const USERINFO_MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function toFailure(message: string, status?: number, networkCode?: string): SourceImportTransportResult {
  const sanitized = sanitizePublicErrorText(message) || "获取 url 失败";
  return {
    ok: false,
    error: sanitized,
    responseStatus: status,
    publicReason: status ? `HTTP ${status}` : sanitized,
    errorInfo: createSubscriptionImportErrorInfo({
      category: inferSubscriptionImportErrorCategory(sanitized),
      message: sanitized,
      detail: sanitized,
      httpStatus: status,
      networkCode,
    }),
  };
}

function toSecurityFailure(message: string): SourceImportTransportResult {
  return {
    ok: false,
    error: message,
    publicReason: message,
    errorInfo: createSubscriptionImportErrorInfo({
      category: "security",
      message,
      detail: message,
    }),
  };
}

async function validatePublicFetchTarget(
  url: string
): Promise<
  | { ok: true; addresses: string[] | null }
  | { ok: false; failure: SourceImportTransportResult }
> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, failure: toSecurityFailure("无效的订阅 URL") };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, failure: toSecurityFailure("只支持 HTTP 或 HTTPS 订阅 URL") };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, failure: toSecurityFailure("订阅 URL 不允许包含用户名或密码") };
  }

  try {
    return { ok: true, addresses: await resolvePublicHost(parsed.hostname) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法核验订阅域名的公网地址";
    return { ok: false, failure: toSecurityFailure(message.replace("节点域名", "订阅域名")) };
  }
}

async function readFetchBodyLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("response too large").catch(() => undefined);
      throw new ResponseTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function requestUnpinnedText(params: {
  url: string;
  method: "GET" | "HEAD";
  userAgent: string;
  maxBytes: number;
  signal: AbortSignal;
}): Promise<DirectHttpResponse> {
  const response = await fetch(params.url, {
    method: params.method,
    headers: {
      "User-Agent": params.userAgent,
      Accept: "text/plain, application/yaml, application/x-yaml, */*;q=0.8",
      "Cache-Control": "no-cache",
    },
    redirect: "manual",
    signal: params.signal,
  });
  const headers = headersToRecord(response.headers);
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel("redirect response is not consumed").catch(() => undefined);
    return { status: response.status, headers, content: "" };
  }
  const contentLength = Number(headers["content-length"] || "0");
  if (Number.isFinite(contentLength) && contentLength > params.maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError();
  }
  const content = params.method === "HEAD" ? "" : await readFetchBodyLimited(response, params.maxBytes);
  return { status: response.status, headers, content };
}

async function fetchTextDirect(
  request: SourceImportTransportRequest,
  options: { allowInvalidTls?: boolean; signal?: AbortSignal } = {}
): Promise<SourceImportTransportResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  const signal = AbortSignal.any([controller.signal, ...(request.signal ? [request.signal] : []), ...(options.signal ? [options.signal] : [])]);

  try {
    let currentUrl = request.url;
    let response: DirectHttpResponse | null = null;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      // long: 每次重定向都重新解析并固定到已核验的公网 IP，避免订阅地址借重定向访问内网。
      const validation = await validatePublicFetchTarget(currentUrl);
      signal.throwIfAborted();
      if (!validation.ok) return validation.failure;

      const method = request.purpose === "userinfo" ? "HEAD" : "GET";
      response = validation.addresses
        ? await requestPinnedText({
            url: currentUrl,
            addresses: validation.addresses,
            method,
            userAgent: request.userAgent,
            maxBytes: request.maxBytes,
            signal,
            allowInvalidTls: options.allowInvalidTls,
          })
        : await requestUnpinnedText({
            url: currentUrl,
            method,
            userAgent: request.userAgent,
            maxBytes: request.maxBytes,
            signal,
          });

      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.location;
      if (!location) break;
      currentUrl = new URL(location, currentUrl).toString();
      response = null;
    }

    if (!response) return toFailure("订阅重定向次数过多", 310);
    const { headers, content } = response;
    if (response.status < 200 || response.status >= 300) {
      return toFailure(`HTTP ${response.status}`, response.status);
    }

    return {
      ok: true,
      content,
      headers,
      responseStatus: response.status,
    };
  } catch (error) {
    if (error instanceof ResponseTooLargeError) return toFailure("订阅响应过大", 413);
    const message = error instanceof Error ? error.message : String(error);
    const networkCode = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
    return toFailure(message, undefined, networkCode);
  } finally {
    clearTimeout(timer);
  }
}

export async function importSourceUrlDirect(
  request: SourceImportRequest,
  options: { allowInvalidTls?: boolean; signal?: AbortSignal } = {}
): Promise<SourceImportResult> {
  return importSubscriptionFromUrl(request, {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxBytes: DEFAULT_MAX_BYTES,
    signal: options.signal,
    fetchText: (transportRequest) => fetchTextDirect(transportRequest, options),
  });
}

export async function fetchSourceUserInfoHeadersDirect(source: {
  userinfoUrl?: string;
  userinfoUserAgent?: string;
}): Promise<Record<string, string> | undefined> {
  if (!source.userinfoUrl) return undefined;
  const response = await fetchTextDirect(
    {
      url: source.userinfoUrl,
      userAgent: source.userinfoUserAgent?.trim() || SUBSCRIPTION_IMPORT_USER_AGENTS[0],
      purpose: "userinfo",
      timeoutMs: USERINFO_TIMEOUT_MS,
      maxBytes: USERINFO_MAX_BYTES,
    }
  );
  return response.ok ? response.headers : undefined;
}
