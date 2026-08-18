import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatSubscriptionImportFailures,
  parseSubscriptionUrlBatch,
  runSubscriptionImportWithTimeout,
} from "./batch-import";

afterEach(() => vi.useRealTimers());

describe("parseSubscriptionUrlBatch", () => {
  it("按行提取链接、忽略空行并保留输入顺序", () => {
    expect(parseSubscriptionUrlBatch("  https://a.example/sub  \n\nhttps://b.example/sub\r\n")).toEqual({
      urls: ["https://a.example/sub", "https://b.example/sub"],
      duplicateCount: 0,
    });
  });

  it("仅在当前批次内去除完全相同的链接", () => {
    expect(parseSubscriptionUrlBatch("https://a.example/sub\nhttps://a.example/sub\nhttps://b.example/sub")).toEqual({
      urls: ["https://a.example/sub", "https://b.example/sub"],
      duplicateCount: 1,
    });
  });

  it("汇总失败站点并限制过长的批量结果", () => {
    expect(formatSubscriptionImportFailures([
      { url: "https://slow.example/sub", error: "导入 15s 超时" },
      { url: "not-a-url", error: "无效链接" },
      { url: "https://third.example/sub", error: "HTTP 500" },
    ])).toBe("slow.example：导入 15s 超时；not-a-url：无效链接；另 1 条");
  });

  it("在 15 秒到达时中止当前订阅导入", async () => {
    vi.useFakeTimers();
    const importPromise = runSubscriptionImportWithTimeout((signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const timeoutAssertion = expect(importPromise).rejects.toThrow("导入 15s 超时");

    await vi.advanceTimersByTimeAsync(14_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await timeoutAssertion;
  });
});
