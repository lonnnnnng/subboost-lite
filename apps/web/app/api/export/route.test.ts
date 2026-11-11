import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPORT_TTL_MS, MAX_EXPORT_BYTES, prepareExportFile } from "@/lib/export-files";
import { GET, HEAD } from "./[id]/[fileName]/route";
import { POST } from "./route";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function request(payload: unknown, headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3010/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ payload: JSON.stringify(payload) }),
  });
}

function read(url: string, headers: Record<string, string> = {}, head = false) {
  const address = new URL(url, "http://127.0.0.1:3010");
  const parts = address.pathname.split("/");
  const context = { params: Promise.resolve({ id: parts[3], fileName: decodeURIComponent(parts[4]) }) };
  return (head ? HEAD : GET)(new Request(address, { method: head ? "HEAD" : "GET", headers }), context);
}

async function prepare(content = "proxies: []\n", fileName = "config.yaml", format = "yaml") {
  const response = await POST(request({ content, fileName, format }));
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Disposition")).toBeNull();
  const file = await response.json();
  expect(file.ok).toBe(true);
  return file.url as string;
}

describe("可独立读取的附件下载", () => {
  it.each(["yaml", "json"])("%s 完整保留中文、换行与特殊字符，并返回准确的 UTF-8 字节长度", async (format) => {
    const content = `中文配置: "&+% 🛟"\nLF\r\nCRLF\n${"配置内容\n".repeat(5000)}`;
    const url = await prepare(content, `日常分流.${format}`, format);
    expect(url).toMatch(new RegExp(`/api/export/[a-f0-9]{48}/.*\\.${format}$`));
    const response = await read(url);
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
    const url = await prepare("{}", "../../test\r\nX-Injected: true", "json");
    const response = await read(url);
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

  it("下载扩展不携带页面会话、且 Origin 是扩展或 null 时也能读取已准备的文件", async () => {
    const url = await prepare();
    const variants: Record<string, string>[] = [{}, { Origin: "chrome-extension://download-manager", "Sec-Fetch-Site": "cross-site" }, { Origin: "null" }];
    for (const headers of variants) {
      const response = await read(url, headers);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("proxies: []\n");
    }
    expect((await POST(request({ content: "x", fileName: "x.yaml", format: "yaml" }, { Origin: "chrome-extension://download-manager" }))).status).toBe(403);
  });

  it("只读地址仍校验真实 Host，伪造转发头不能绕过", async () => {
    const url = await prepare();
    expect((await read(url, { Host: "evil.example", "X-Forwarded-Host": "127.0.0.1:3010" })).status).toBe(403);
    vi.stubEnv("SUBCONVERT_ALLOWED_ORIGINS", "http://192.168.1.2:9999");
    expect((await read(url, { Host: "192.168.1.2:9999", Origin: "chrome-extension://manager" })).status).toBe(200);
  });

  it("HEAD 返回完整元数据且不消费文件，随后可并发和重复 GET", async () => {
    const content = "中文文件\n".repeat(100);
    const url = await prepare(content);
    const probe = await read(url, { Range: "bytes=0-1" }, true);
    expect(probe.status).toBe(200);
    expect(probe.headers.get("Content-Length")).toBe(String(Buffer.byteLength(content)));
    expect(probe.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await probe.text()).toBe("");
    const responses = await Promise.all(Array.from({ length: 4 }, () => read(url)));
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get("ETag")).toBe(probe.headers.get("ETag"));
      expect(await response.text()).toBe(content);
    }
  });

  it("中文 UTF-8 内容按字节分段，并发读取后可拼回原文", async () => {
    const content = "节点配置: 🛟 测试\n".repeat(100);
    const bytes = Buffer.from(content);
    const url = await prepare(content);
    const pivot = 7;
    const [first, second] = await Promise.all([read(url, { Range: `bytes=0-${pivot - 1}` }), read(url, { Range: `bytes=${pivot}-` })]);
    expect(first.status).toBe(206);
    expect(second.status).toBe(206);
    expect(first.headers.get("Content-Range")).toBe(`bytes 0-${pivot - 1}/${bytes.length}`);
    expect(first.headers.get("Content-Length")).toBe(String(pivot));
    expect(second.headers.get("Content-Length")).toBe(String(bytes.length - pivot));
    const joined = Buffer.concat([Buffer.from(await first.arrayBuffer()), Buffer.from(await second.arrayBuffer())]);
    expect(joined.equals(bytes)).toBe(true);
    expect(await (await read(url)).text()).toBe(content);
  });

  it.each([
    ["bytes=2-4", "234"], ["bytes=2-999", "23456789"], ["bytes=0-", "0123456789"],
    ["bytes=-3", "789"], ["bytes=-999", "0123456789"],
  ])("支持单段下载 %s", async (range, expected) => {
    const url = await prepare("0123456789");
    const response = await read(url, { Range: range });
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Length")).toBe(String(expected.length));
    expect(await response.text()).toBe(expected);
  });

  it.each(["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=999999999999999999999-"])("越界分段 %s 返回 416 且保留原文件", async (range) => {
    const url = await prepare("0123456789");
    const response = await read(url, { Range: range });
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */10");
    expect(response.headers.get("Content-Length")).toBe("0");
    expect(await response.text()).toBe("");
    expect((await read(url)).status).toBe(200);
  });

  it("多段请求返回完整文件，If-Range 仅在强 ETag 匹配时分段", async () => {
    const url = await prepare("0123456789");
    expect((await read(url, { Range: "bytes=0-1,4-5" })).status).toBe(200);
    const etag = (await read(url, {}, true)).headers.get("ETag")!;
    expect((await read(url, { Range: "bytes=0-1", "If-Range": etag })).status).toBe(206);
    const mismatch = await read(url, { Range: "bytes=0-1", "If-Range": '"old"' });
    expect(mismatch.status).toBe(200);
    expect(await mismatch.text()).toBe("0123456789");
  });

  it("过期、错误文件名和未知 ID 均返回 404，HEAD 不延长有效期", async () => {
    const url = await prepare();
    expect((await read(url.replace("config.yaml", "other.yaml"))).status).toBe(404);
    expect((await read(`/api/export/${"0".repeat(48)}/config.yaml`)).status).toBe(404);
    vi.advanceTimersByTime(EXPORT_TTL_MS - 1);
    expect((await read(url, {}, true)).status).toBe(200);
    vi.advanceTimersByTime(1);
    expect((await read(url)).status).toBe(404);
    expect((await read(url, {}, true)).status).toBe(404);
  });

  it("总容量到达上限时拒绝准备新文件，不影响已有地址；过期后释放容量", async () => {
    const content = "x".repeat(MAX_EXPORT_BYTES);
    const url = await prepare(content);
    for (let index = 0; index < 5; index++) expect(prepareExportFile(content, "x.yaml", "yaml")).not.toBeNull();
    expect((await POST(request({ content, fileName: "x.yaml", format: "yaml" }))).status).toBe(503);
    expect((await read(url)).headers.get("Content-Length")).toBe(String(MAX_EXPORT_BYTES));
    vi.advanceTimersByTime(EXPORT_TTL_MS);
    expect(prepareExportFile(content, "x.yaml", "yaml")).not.toBeNull();
  });

  it("文件数达到上限也不挤掉现有文件，相同文件名生成独立地址", async () => {
    const first = prepareExportFile("first", "config.yaml", "yaml")!;
    const second = prepareExportFile("second", "config.yaml", "yaml")!;
    expect(first.url).not.toBe(second.url);
    for (let index = 0; index < 126; index++) expect(prepareExportFile("x", "config.yaml", "yaml")).not.toBeNull();
    expect(prepareExportFile("x", "config.yaml", "yaml")).toBeNull();
    expect(await (await read(first.url)).text()).toBe("first");
    expect(await (await read(second.url)).text()).toBe("second");
  });
});
