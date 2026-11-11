import { isAllowedApiRequest } from "@/lib/api-access";
import { findExportFile } from "@/lib/export-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; fileName: string }> };

function byteRange(value: string | null, length: number): { start: number; end: number } | null | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  // long: 下载管理器使用单段 Range；其他格式忽略并返回完整文件，不能把多段请求伪装成单段 206。
  if (!match || (!match[1] && !match[2])) return undefined;
  const start = match[1] ? Number(match[1]) : Math.max(0, length - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(length - 1, Number(match[2])) : length - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= length || end < start) return null;
  return { start, end };
}

async function serveFile(request: Request, context: Context, head: boolean): Promise<Response> {
  // long: 只读文件以不可猜测的随机地址授权，允许扩展脱离页面读取；仍校验真实 Host，创建文件的同源限制不变。
  const address = new Request(request.url, { headers: { Host: request.headers.get("host") || new URL(request.url).host } });
  if (!isAllowedApiRequest(address)) return new Response(null, { status: 403, headers: { "Cache-Control": "no-store" } });
  const { id, fileName } = await context.params;
  const file = findExportFile(id, fileName);
  if (!file) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  const encodedName = encodeURIComponent(file.fileName).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="config${file.fileName.endsWith(".json") ? ".json" : ".yaml"}"; filename*=UTF-8''${encodedName}`,
    "Content-Length": String(file.bytes.length),
    "Accept-Ranges": "bytes",
    ETag: file.etag,
    "Cache-Control": "no-store, no-transform",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  // long: HEAD 只探测文件元数据，不能消费地址；后续 GET 和分段读取必须始终看到同一份内容。
  if (head) return new Response(null, { headers });
  const ifRange = request.headers.get("if-range");
  const range = !ifRange || ifRange === file.etag ? byteRange(request.headers.get("range"), file.bytes.length) : undefined;
  if (range === null) {
    headers.set("Content-Range", `bytes */${file.bytes.length}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }
  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${file.bytes.length}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(new Uint8Array(file.bytes.subarray(range.start, range.end + 1)), { status: 206, headers });
  }
  return new Response(new Uint8Array(file.bytes), { headers });
}

export async function GET(request: Request, context: Context): Promise<Response> {
  return serveFile(request, context, false);
}

export async function HEAD(request: Request, context: Context): Promise<Response> {
  return serveFile(request, context, true);
}
