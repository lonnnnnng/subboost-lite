import { isAllowedApiRequest } from "@/lib/api-access";

export const runtime = "nodejs";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// long: 表单百分号编码最多膨胀为原始 UTF-8 的三倍，读取前和读取中都限流，避免大请求占满内存。
const MAX_FORM_BYTES = MAX_FILE_BYTES * 3 + 64 * 1024;

function failure(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  if (!isAllowedApiRequest(request)) return failure("当前访问地址未获允许或请求不是同源", 403);
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers.get("content-type") || "")) {
    return failure("不支持的导出请求格式", 415);
  }
  if (Number(request.headers.get("content-length")) > MAX_FORM_BYTES) return failure("导出文件不能超过 10 MB", 413);
  if (!request.body) return failure("导出内容为空", 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_FORM_BYTES) {
        await reader.cancel().catch(() => undefined);
        return failure("导出文件不能超过 10 MB", 413);
      }
      chunks.push(value);
    }
  } catch {
    return failure("读取导出请求失败，请重试", 400);
  } finally {
    reader.releaseLock();
  }

  let payload: unknown;
  try {
    const encoded = Buffer.concat(chunks, length).toString("utf8");
    payload = JSON.parse(new URLSearchParams(encoded).get("payload") || "");
  } catch {
    return failure("导出请求内容无效", 400);
  }
  if (!payload || typeof payload !== "object") return failure("导出请求内容无效", 400);
  const { content, fileName, format } = payload as Record<string, unknown>;
  if (typeof content !== "string" || !content || typeof fileName !== "string" || (format !== "yaml" && format !== "json")) {
    return failure("请提供有效的文件内容、名称和格式", 400);
  }
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) return failure("导出文件不能超过 10 MB", 413);
  const extension = format === "json" ? ".json" : ".yaml";
  let name = fileName.trim().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^\.+/, "").slice(0, 160) || "config";
  if (!name.endsWith(extension)) name += extension;
  const encodedName = encodeURIComponent(name).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const bytes = Buffer.from(content, "utf8");
  // long: 配置只在本次请求的内存中原样返回；显式附件、长度和禁用缓存，让浏览器完成普通文件下载而无需临时 Blob。
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="config${extension}"; filename*=UTF-8''${encodedName}`,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store, no-transform",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
