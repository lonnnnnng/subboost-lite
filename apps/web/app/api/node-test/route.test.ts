import { beforeEach, describe, expect, it, vi } from "vitest";
import { testNodeBatch } from "@/lib/node-test/server";
import { POST } from "./route";

vi.mock("@/lib/node-test/server", () => ({
  isNodeTestRequestItem: () => true,
  testNodeBatch: vi.fn(),
}));

vi.mock("@/lib/node-test/types", () => ({
  MAX_SPEED_TEST_NODES: 5,
}));

const mockedTestNodeBatch = vi.mocked(testNodeBatch);
const nodes = [{ key: "source:0", node: { name: "test", type: "http", server: "node.example", port: 443 } }];

function request(tcpTimeoutSeconds: unknown, mode: unknown = "latency", durationSeconds?: unknown): Request {
  return new Request("http://127.0.0.1:3010/api/node-test", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "127.0.0.1:3010" },
    body: JSON.stringify({ nodes, mode, durationSeconds, tcpTimeoutSeconds }),
  });
}

describe("node test API connectivity timeout", () => {
  beforeEach(() => {
    mockedTestNodeBatch.mockReset();
    mockedTestNodeBatch.mockResolvedValue({ results: [] });
  });

  it("converts a valid timeout from seconds to milliseconds", async () => {
    const response = await POST(request(12.5));

    expect(response.status).toBe(200);
    expect(mockedTestNodeBatch).toHaveBeenCalledWith(nodes, "latency", expect.objectContaining({
      tcpTimeoutMs: 12_500,
      onResult: expect.any(Function),
    }));
  });

  it("passes speed mode and duration to the batch tester", async () => {
    const response = new Request("http://127.0.0.1:3010/api/node-test", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "127.0.0.1:3010" },
      body: JSON.stringify({ nodes, mode: "speed", durationSeconds: 30, speedConcurrency: 10, speedSource: "cloudflare", speedMaxDataMb: 300, tcpTimeoutSeconds: 3.5 }),
    });
    const result = await POST(response);

    expect(result.status).toBe(200);
    expect(mockedTestNodeBatch).toHaveBeenCalledWith(nodes, "speed", expect.objectContaining({
      tcpTimeoutMs: 3_500,
      durationMs: 30_000,
      concurrency: 10,
      source: "cloudflare",
      url: undefined,
      maxDataBytes: 300_000_000,
      onProgress: expect.any(Function),
      onResult: expect.any(Function),
    }));
  });

  it("streams speed progress before the final result", async () => {
    mockedTestNodeBatch.mockImplementation(async (_items, _mode, options) => {
      options?.onProgress?.({
        key: "source:0",
        currentMbps: 42.5,
        peakMbps: 48.1,
        sampleBytes: 5_000_000,
        transferredBytes: 6_000_000,
        durationSeconds: 1,
      });
      return { results: [], coreVersion: "test" };
    });

    const response = await POST(new Request("http://127.0.0.1:3010/api/node-test", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "127.0.0.1:3010" },
      body: JSON.stringify({ nodes, mode: "speed", durationSeconds: 15, speedConcurrency: 10, speedSource: "cloudflare", speedMaxDataMb: 300 }),
    }));
    const messages = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as { type: string; proxy?: { downloadCurrentMbps?: number }; coreVersion?: string });

    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(messages).toEqual([
      expect.objectContaining({ type: "progress", proxy: expect.objectContaining({ downloadCurrentMbps: 42.5 }) }),
      expect.objectContaining({ type: "complete", coreVersion: "test" }),
    ]);
  });

  it("streams each completed latency result before the final summary", async () => {
    mockedTestNodeBatch.mockImplementation(async (_items, _mode, options) => {
      options?.onResult?.({
        key: "source:0",
        tcp: { status: "reachable", latencyMs: 12, pinnedServer: "203.0.113.1" },
        proxy: { status: "available", latencyMs: 88 },
        testedAt: "2026-08-19T00:00:00.000Z",
      });
      return { results: [], coreVersion: "test" };
    });

    const response = await POST(request(3.5));
    const messages = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as { type: string; result?: { key?: string } });

    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(messages).toEqual([
      expect.objectContaining({ type: "result", result: expect.objectContaining({ key: "source:0" }) }),
      expect.objectContaining({ type: "complete" }),
    ]);
  });

  it("allows latency tests with more than five nodes", async () => {
    const manyNodes = Array.from({ length: 6 }, (_, index) => ({
      key: `source:${index}`,
      node: { name: `test-${index}`, type: "http", server: "node.example", port: 443 },
    }));
    const response = new Request("http://127.0.0.1:3010/api/node-test", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "127.0.0.1:3010" },
      body: JSON.stringify({ nodes: manyNodes, mode: "latency", tcpTimeoutSeconds: 3.5 }),
    });
    const result = await POST(response);

    expect(result.status).toBe(200);
    expect(mockedTestNodeBatch).toHaveBeenCalledWith(manyNodes, "latency", expect.objectContaining({
      tcpTimeoutMs: 3_500,
      onResult: expect.any(Function),
    }));
  });

  it("rejects speed tests with more than five nodes", async () => {
    const manyNodes = Array.from({ length: 6 }, (_, index) => ({
      key: `source:${index}`,
      node: { name: `test-${index}`, type: "http", server: "node.example", port: 443 },
    }));
    const response = new Request("http://127.0.0.1:3010/api/node-test", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "127.0.0.1:3010" },
      body: JSON.stringify({ nodes: manyNodes, mode: "speed", durationSeconds: 30, speedConcurrency: 10, tcpTimeoutSeconds: 3.5 }),
    });
    const result = await POST(response);

    expect(result.status).toBe(400);
    await expect(result.json()).resolves.toMatchObject({ ok: false, error: "单次最多测速 5 个节点，请分批选择" });
    expect(mockedTestNodeBatch).not.toHaveBeenCalled();
  });

  it("rejects speed mode without a valid duration", async () => {
    const response = await POST(request(3.5, "speed"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "测速时长必须是 15-300 秒的整数" });
    expect(mockedTestNodeBatch).not.toHaveBeenCalled();
  });

  it.each([0, 101, 1.5])("rejects invalid speed concurrency: %s", async (speedConcurrency) => {
    const response = new Request("http://127.0.0.1:3010/api/node-test", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "127.0.0.1:3010" },
      body: JSON.stringify({ nodes, mode: "speed", durationSeconds: 30, speedConcurrency, tcpTimeoutSeconds: 3.5 }),
    });
    const result = await POST(response);

    expect(result.status).toBe(400);
    await expect(result.json()).resolves.toMatchObject({ ok: false, error: "测速并发数必须是 1-100 的整数" });
    expect(mockedTestNodeBatch).not.toHaveBeenCalled();
  });

  it.each([0.5, 30.5, "3.5"])("rejects an invalid timeout value: %s", async (value) => {
    const response = await POST(request(value));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "连通性超时必须是 1-30 秒的数字" });
    expect(mockedTestNodeBatch).not.toHaveBeenCalled();
  });

  it("accepts an HTTPS custom speed source", async () => {
    const response = new Request("http://127.0.0.1:3010/api/node-test", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "127.0.0.1:3010" },
      body: JSON.stringify({
        nodes,
        mode: "speed",
        durationSeconds: 15,
        speedConcurrency: 4,
        speedSource: "custom",
        speedUrl: "https://example.com/test.bin",
        speedMaxDataMb: 500,
      }),
    });

    expect((await POST(response)).status).toBe(200);
    expect(mockedTestNodeBatch).toHaveBeenCalledWith(nodes, "speed", expect.objectContaining({
      source: "custom",
      url: "https://example.com/test.bin",
      maxDataBytes: 500_000_000,
    }));
  });

  it.each(["http://example.com/test.bin", "not-a-url"])("rejects an invalid custom source URL: %s", async (speedUrl) => {
    const response = new Request("http://127.0.0.1:3010/api/node-test", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "127.0.0.1:3010" },
      body: JSON.stringify({ nodes, mode: "speed", durationSeconds: 15, speedConcurrency: 4, speedSource: "custom", speedUrl, speedMaxDataMb: 300 }),
    });

    const result = await POST(response);
    expect(result.status).toBe(400);
    expect(mockedTestNodeBatch).not.toHaveBeenCalled();
  });

  it.each([49, 2049, 300.5])("rejects an invalid sample cap: %s", async (speedMaxDataMb) => {
    const response = new Request("http://127.0.0.1:3010/api/node-test", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "127.0.0.1:3010" },
      body: JSON.stringify({ nodes, mode: "speed", durationSeconds: 15, speedConcurrency: 4, speedSource: "github", speedMaxDataMb }),
    });

    const result = await POST(response);
    expect(result.status).toBe(400);
    await expect(result.json()).resolves.toMatchObject({ ok: false, error: "测速采样上限必须是 50-2048 MB 的整数" });
    expect(mockedTestNodeBatch).not.toHaveBeenCalled();
  });
});
