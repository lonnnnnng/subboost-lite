import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

afterEach(() => vi.unstubAllEnvs());

function request(payload: unknown, headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3010/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ payload: JSON.stringify(payload) }),
  });
}

describe("原生附件下载", () => {
  it.each(["yaml", "json"])("%s 完整保留中文、换行与特殊字符，并返回准确的 UTF-8 字节长度", async (format) => {
    const content = `中文配置: "&+% 🛟"\nLF\r\nCRLF\n${"配置内容\n".repeat(5000)}`;
    const response = await POST(request({ content, fileName: `日常分流.${format}`, format }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(Buffer.byteLength(content)));
    expect(response.headers.get("Content-Disposition")).toContain(`filename*=UTF-8''${encodeURIComponent(`日常分流.${format}`)}`);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
    expect(await response.text()).toBe(content);
  });

  it("拒绝跨站导出且不反射文件正文", async () => {
    const response = await POST(request({ content: "private configuration", fileName: "test.yaml", format: "yaml" }, { Origin: "http://evil.example" }));
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("private configuration");
  });

  it("只允许显式配置的局域网地址同源导出", async () => {
    vi.stubEnv("SUBCONVERT_ALLOWED_ORIGINS", "http://192.168.1.2:9999");
    const response = await POST(request({ content: "proxies: []\n", fileName: "config.yaml", format: "yaml" }, { Host: "192.168.1.2:9999", Origin: "http://192.168.1.2:9999" }));
    expect(response.status).toBe(200);
  });

  it("文件名不能注入路径或响应头", async () => {
    const response = await POST(request({ content: "{}", fileName: "../../test\r\nX-Injected: true", format: "json" }));
    expect(response.status).toBe(200);
    expect(response.headers.has("X-Injected")).toBe(false);
    expect(response.headers.get("Content-Disposition")).not.toMatch(/[\r\n/\\]/);
  });

  it.each([null, {}, { content: "x", fileName: "x.html", format: "html" }, { content: "", fileName: "x.yaml", format: "yaml" }])("拒绝无效请求 %j", async (payload) => {
    expect((await POST(request(payload))).status).toBe(400);
  });

  it("在读取正文前拒绝过大的表单", async () => {
    expect((await POST(request({}, { "Content-Length": String(40 * 1024 * 1024) }))).status).toBe(413);
  });

  it("超过文件字节上限时不返回附件", async () => {
    const response = await POST(request({ content: "中".repeat(4 * 1024 * 1024), fileName: "x.yaml", format: "yaml" }));
    expect(response.status).toBe(413);
    expect(response.headers.has("Content-Disposition")).toBe(false);
  });
});
