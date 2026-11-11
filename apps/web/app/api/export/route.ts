import { isAllowedApiRequest } from "@/lib/api-access";
import { MAX_EXPORT_BYTES, prepareExportFile } from "@/lib/export-files";

export const runtime = "nodejs";
// long: 表单百分号编码最多膨胀为原始 UTF-8 的三倍，读取前和读取中都限流，避免大请求占满内存。
const MAX_FORM_BYTES = MAX_EXPORT_BYTES * 3 + 64 * 1024;

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
  if (Buffer.byteLength(content, "utf8") > MAX_EXPORT_BYTES) return failure("导出文件不能超过 10 MB", 413);
  const file = prepareExportFile(content, fileName, format);
  if (!file) return failure("当前导出文件较多，请稍后重试", 503);
  // long: 下载扩展通常只会重放 GET，先准备文件再返回独立地址，避免它丢失 POST 正文后得到 405。
  return Response.json({ ok: true, ...file }, { headers: { "Cache-Control": "no-store" } });
}
