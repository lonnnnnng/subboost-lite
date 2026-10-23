import { afterEach, describe, expect, it, vi } from "vitest";
import { importSourceUrlDirect } from "@/lib/source-import";
import { POST } from "./route";

vi.mock("@/lib/source-import", () => ({ importSourceUrlDirect: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("订阅导入入口", () => {
  it("跨站调用在抓取订阅前被拒绝", async () => {
    vi.stubEnv("SUBCONVERT_ALLOWED_ORIGINS", "http://192.168.1.2:9999");
    const response = await POST(new Request("http://192.168.1.2:9999/api/import", {
      method: "POST",
      headers: { Host: "192.168.1.2:9999", Origin: "http://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/sub" }),
    }));
    expect(response.status).toBe(403);
    expect(importSourceUrlDirect).not.toHaveBeenCalled();
  });

  it("允许配置后的局域网同源请求继续校验导入内容", async () => {
    vi.stubEnv("SUBCONVERT_ALLOWED_ORIGINS", "http://192.168.1.2:9999");
    const response = await POST(new Request("http://127.0.0.1:9999/api/import", {
      method: "POST", headers: { Host: "192.168.1.2:9999", Origin: "http://192.168.1.2:9999" }, body: "{}",
    }));
    expect(response.status).toBe(400);
    expect(importSourceUrlDirect).not.toHaveBeenCalled();
  });
});
