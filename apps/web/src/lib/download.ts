export type DownloadFormat = "yaml" | "json";

export function downloadText(content: string, fileName: string, format: DownloadFormat, onError: (message: string) => void): void {
  const frame = document.createElement("iframe");
  const form = document.createElement("form");
  const payload = document.createElement("input");
  frame.name = `subconvert-download-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  frame.hidden = true;
  frame.title = "文件下载";
  form.hidden = true;
  form.method = "POST";
  form.action = "/api/export";
  form.target = frame.name;
  form.acceptCharset = "UTF-8";
  payload.type = "hidden";
  payload.name = "payload";
  // long: 用 JSON 字符串承载换行，避免原生表单把 YAML 的 LF 自动改成 CRLF，下载内容须与预览一致。
  payload.value = JSON.stringify({ content, fileName, format });
  form.appendChild(payload);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    clearTimeout(timer);
    form.remove();
    frame.remove();
  };
  frame.addEventListener("load", () => {
    // long: 附件响应交给浏览器保存；只有接口错误才在 iframe 中加载 JSON，需把失败原因传回工作台。
    const text = frame.contentDocument?.body?.textContent?.trim();
    if (!text) return;
    let error = "下载请求失败，请重试";
    try {
      const response: unknown = JSON.parse(text);
      if (response && typeof response === "object" && "error" in response && typeof response.error === "string") error = response.error;
    } catch { /* long: 网关错误页不直接展示 HTML，避免把服务器内部信息带进下载提示。 */ }
    cleanup();
    onError(error);
  });
  frame.addEventListener("error", () => {
    cleanup();
    onError("下载请求失败，请检查连接后重试");
  });
  document.body.append(frame, form);
  try {
    // long: 原生同源附件请求有明确字节长度，不依赖 Blob URL 的异步读取及撤销时机，也不跳走当前工作台。
    form.submit();
    form.remove();
    timer = setTimeout(cleanup, 60_000);
  } catch (error) {
    cleanup();
    throw error;
  }
}
