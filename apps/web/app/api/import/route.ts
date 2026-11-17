import { NextResponse } from "next/server";
import { isAllowedApiRequest } from "@/lib/api-access";
import { isTlsCertificateError } from "@subboost/server-core/subscription/tls-certificate-error";
import { importSourceUrlDirect } from "@/lib/source-import";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isAllowedApiRequest(request)) {
    return NextResponse.json({ ok: false, error: "当前访问地址未获允许或请求不是同源，请检查服务器允许的访问地址" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求内容不是有效 JSON" }, { status: 400 });
  }

  const url = typeof (body as { url?: unknown })?.url === "string"
    ? (body as { url: string }).url.trim()
    : "";
  if (!url || url.length > 8192) {
    return NextResponse.json({ ok: false, error: "请输入有效的订阅链接" }, { status: 400 });
  }

  // long: URL 只在当前转换请求中抓取，结果直接返回浏览器，不创建订阅记录或落盘缓存。
  // long: 为浏览器的 15 秒期限预留响应时间，证书审核重试与普通抓取必须共享预算，不能重新计时。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 14_000);
  const signal = AbortSignal.any([request.signal, controller.signal]);
  try {
    const result = await importSourceUrlDirect({ url }, { signal });
    if (!result.ok) {
      const certificateError = [
        result.error,
        result.publicReason,
        result.errorInfo.detail,
        result.errorInfo.networkCode,
      ]
        .filter((value): value is string => Boolean(value))
        .join("\n");

      if (!signal.aborted && isTlsCertificateError(certificateError)) {
        // long: 证书异常时只生成待审核候选；服务端不会直接把不可信响应加入来源。
        const reviewCandidate = await importSourceUrlDirect({ url }, { allowInvalidTls: true, signal });
        if (reviewCandidate.ok && reviewCandidate.parsedNodes.length > 0) {
          // long: 复用订阅导入器已经验证成功的解析结果，避免 Base64 或节点链接订阅被 YAML 二次解析误判为空。
          return NextResponse.json({
            ok: true,
            reviewRequired: true,
            reviewReason: result.error,
            content: reviewCandidate.content,
            nodes: reviewCandidate.parsedNodes,
            errors: reviewCandidate.parseErrors,
            directDomains: reviewCandidate.directDomains,
            baseConfigYaml: reviewCandidate.baseConfigYaml,
          });
        }
      }

      return NextResponse.json(
        { ok: false, error: result.error, detail: result.publicReason ?? null },
        { status: result.responseStatus && result.responseStatus >= 400 ? result.responseStatus : 422 }
      );
    }

    return NextResponse.json({
      ok: true,
      reviewRequired: false,
      content: result.content,
      nodes: result.parsedNodes,
      errors: result.parseErrors,
      directDomains: result.directDomains,
      baseConfigYaml: result.baseConfigYaml,
    });
  } finally {
    clearTimeout(timer);
  }
}
