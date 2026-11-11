import { createHash, randomBytes } from "node:crypto";

export const MAX_EXPORT_BYTES = 10 * 1024 * 1024;
export const EXPORT_TTL_MS = 10 * 60 * 1000;
const MAX_STORED_BYTES = 64 * 1024 * 1024;
const MAX_STORED_FILES = 128;

type ExportFile = {
  id: string;
  fileName: string;
  bytes: Buffer;
  etag: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

// long: Next 会分别打包准备和下载路由，存储必须共享于进程，否则 POST 成功后 GET 仍可能找不到文件。
const processState = globalThis as typeof globalThis & { __subconvertExportFiles?: Map<string, ExportFile> };
const files = processState.__subconvertExportFiles ??= new Map<string, ExportFile>();

export function prepareExportFile(content: string, fileName: string, format: "yaml" | "json") {
  const bytes = Buffer.from(content, "utf8");
  if (!bytes.length || bytes.length > MAX_EXPORT_BYTES) throw new Error("导出文件大小无效");
  let storedBytes = 0;
  for (const [id, file] of files) {
    if (file.expiresAt <= Date.now()) {
      clearTimeout(file.timer);
      files.delete(id);
    } else {
      storedBytes += file.bytes.length;
    }
  }
  // long: 活跃地址可能正在被扩展探测或重试，容量不足时拒绝新文件，不能淘汰正在下载的配置。
  if (files.size >= MAX_STORED_FILES || storedBytes + bytes.length > MAX_STORED_BYTES) return null;
  const extension = `.${format}`;
  let name = fileName.trim().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^\.+/, "").slice(0, 160) || "config";
  if (!name.endsWith(extension)) name += extension;
  const id = randomBytes(24).toString("hex");
  const expiresAt = Date.now() + EXPORT_TTL_MS;
  // long: 下载地址固定有效十分钟，HEAD、重试和断点续传均不消费或续期；到期即释放敏感配置的内存。
  const timer = setTimeout(() => files.delete(id), EXPORT_TTL_MS);
  timer.unref();
  files.set(id, { id, fileName: name, bytes, etag: `"${createHash("sha256").update(bytes).digest("hex")}"`, expiresAt, timer });
  return { url: `/api/export/${id}/${encodeURIComponent(name)}`, expiresAt };
}

export function findExportFile(id: string, fileName: string): ExportFile | undefined {
  if (!/^[a-f0-9]{48}$/.test(id)) return undefined;
  const file = files.get(id);
  if (!file) return undefined;
  if (file.expiresAt <= Date.now()) {
    clearTimeout(file.timer);
    files.delete(id);
    return undefined;
  }
  return file.fileName === fileName ? file : undefined;
}
