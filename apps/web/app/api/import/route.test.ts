import { afterEach, describe, expect, it, vi } from "vitest";
import { importSourceUrlDirect } from "@/lib/source-import";
import { POST } from "./route";
import { createSubscriptionImportErrorInfo } from "@subboost/core/subscription/import-error";

vi.mock("@/lib/source-import", () => ({ importSourceUrlDirect: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("订阅导入入口", () => {
  it.each(["certificate has expired", "Hostname/IP does not match certificate's altnames"])("证书异常 %s 仍进入人工审核且共享取消预算", async (error) => {
    const candidate = {
      ok: true as const,
      content: "Base64 candidate",
      headers: {},
      parsedNodes: [{ name: "test", type: "ss" as const, server: "ss.example.com", port: 8388, cipher: "aes-128-gcm", password: "test" }],
      parseErrors: [],
    };
    vi.mocked(importSourceUrlDirect).mockResolvedValueOnce({
      ok: false, error, errorInfo: createSubscriptionImportErrorInfo({ category: "network", message: error }),
    }).mockResolvedValueOnce(candidate);
    const response = await POST(new Request("http://127.0.0.1:3010/api/import", {
      method: "POST", body: JSON.stringify({ url: "https://example.com/sub" }),
    }));
    expect(await response.json()).toMatchObject({ ok: true, reviewRequired: true, nodes: candidate.parsedNodes });
    const calls = vi.mocked(importSourceUrlDirect).mock.calls;
    expect(calls[1][1]).toMatchObject({ allowInvalidTls: true });
    expect(calls[0][1]?.signal).toBe(calls[1][1]?.signal);
  });

  it("证书请求耗尽总预算后不再开启新一轮抓取", async () => {
    vi.useFakeTimers();
    const error = "certificate has expired";
    vi.mocked(importSourceUrlDirect).mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 14_000));
      return { ok: false, error, errorInfo: createSubscriptionImportErrorInfo({ category: "network", message: error }) };
    });
    const response = POST(new Request("http://127.0.0.1:3010/api/import", {
      method: "POST", body: JSON.stringify({ url: "https://example.com/sub" }),
    }));
    await vi.advanceTimersByTimeAsync(14_000);
    expect((await response).status).toBe(422);
    expect(importSourceUrlDirect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

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
