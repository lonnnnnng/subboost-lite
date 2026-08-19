import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendSubscriptionFileContents,
  formatSubscriptionImportFailures,
  mapSubscriptionImportsWithConcurrency,
  parseSubscriptionUrlBatch,
  runSubscriptionImportWithTimeout,
} from "./batch-import";

afterEach(() => vi.useRealTimers());

describe("appendSubscriptionFileContents", () => {
  it("按文件选择顺序追加到当前订阅链接", () => {
    expect(appendSubscriptionFileContents(
      "https://current.example/sub",
      ["https://first.example/sub\n", "https://second.example/sub\nhttps://third.example/sub"]
    )).toBe([
      "https://current.example/sub",
      "https://first.example/sub",
      "https://second.example/sub",
      "https://third.example/sub",
    ].join("\n"));
  });

  it("忽略空文件并清理文件块首尾空行", () => {
    expect(appendSubscriptionFileContents("", ["\n\nhttps://first.example/sub\r\n", " \n ", "https://second.example/sub\n\n"]))
      .toBe("https://first.example/sub\nhttps://second.example/sub");
  });
});

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

  it("排队等待不占用每条订阅自己的 15 秒超时窗口", async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    const resultPromise = mapSubscriptionImportsWithConcurrency(
      ["first", "second"],
      (item) => runSubscriptionImportWithTimeout((signal) => new Promise<string>((resolve, reject) => {
        started.push(item);
        const completionId = setTimeout(() => resolve(item), 10_000);
        signal.addEventListener("abort", () => {
          clearTimeout(completionId);
          reject(new Error("aborted"));
        }, { once: true });
      })),
      1
    );

    expect(started).toEqual(["first"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started).toEqual(["first", "second"]);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(resultPromise).resolves.toEqual(["first", "second"]);
  });

  it("默认同时执行 10 条订阅并让后续链接等待空闲槽位", async () => {
    const releases: Array<() => void> = [];
    const started: number[] = [];
    const resultPromise = mapSubscriptionImportsWithConcurrency(
      Array.from({ length: 11 }, (_, index) => index),
      (item) => new Promise<number>((resolve) => {
        started.push(item);
        releases.push(() => resolve(item));
      })
    );

    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    releases[0]();
    await vi.waitFor(() => expect(started).toHaveLength(11));
    releases.slice(1).forEach((release) => release());

    await expect(resultPromise).resolves.toEqual(Array.from({ length: 11 }, (_, index) => index));
  });
});
