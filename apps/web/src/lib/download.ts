export type DownloadFormat = "yaml" | "json";

export async function downloadText(content: string, fileName: string, format: DownloadFormat): Promise<void> {
  // long: JSON 保留 YAML 原始换行；先准备再 GET，使下载扩展无需携带 POST 正文也能独立重试。
  const response = await fetch("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ payload: JSON.stringify({ content, fileName, format }) }),
    signal: AbortSignal.timeout(15_000),
  });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok || !result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !("url" in result) || typeof result.url !== "string") {
    const message = result && typeof result === "object" && "error" in result && typeof result.error === "string" ? result.error : "准备下载文件失败，请重试";
    throw new Error(message);
  }
  const url = new URL(result.url, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/export/")) throw new Error("下载地址无效，请重试");
  const anchor = document.createElement("a");
  anchor.href = url.href;
  anchor.download = fileName;
  anchor.hidden = true;
  anchor.referrerPolicy = "no-referrer";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}
