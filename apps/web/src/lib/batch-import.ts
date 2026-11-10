export type SubscriptionUrlBatch = {
  urls: string[];
  duplicateCount: number;
};

export type SubscriptionImportFailure = {
  url: string;
  error: string;
};

export const SUBSCRIPTION_IMPORT_TIMEOUT_MS = 15_000;
export const SUBSCRIPTION_IMPORT_TIMEOUT_MESSAGE = "导入 15s 超时";
export const SUBSCRIPTION_IMPORT_CONCURRENCY = 10;

export function appendSubscriptionFileContents(current: string, fileContents: readonly string[]): string {
  // long: 文件只负责补充订阅链接，统一清理块边界的空行后再拼接，避免原输入与多个文件首尾粘成同一条 URL。
  return [current, ...fileContents]
    .map((content) => content.replace(/^[\r\n]+|[\r\n]+$/g, ""))
    .filter((content) => content.trim().length > 0)
    .join("\n");
}

export async function runSubscriptionImportWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = SUBSCRIPTION_IMPORT_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(SUBSCRIPTION_IMPORT_TIMEOUT_MESSAGE));
    }, timeoutMs);
  });
  try {
    // long: 除了取消网络请求，也要结束不响应 signal 的操作，让后续排队链接能继续取得并发槽。
    return await Promise.race([operation(controller.signal), timeout]);
  } catch (error) {
    // long: 只把本地定时器触发的中止归类为 15 秒超时，其他网络异常保留原始错误供批量汇总。
    if (controller.signal.aborted) throw new Error(SUBSCRIPTION_IMPORT_TIMEOUT_MESSAGE);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function mapSubscriptionImportsWithConcurrency<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency = SUBSCRIPTION_IMPORT_CONCURRENCY
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runWorker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      // long: 链接取得并发槽后才进入业务 worker，单条 15 秒计时不会包含前面的排队等待时间。
      results[index] = await worker(items[index], index);
    }
  };

  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length);
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
}

export function parseSubscriptionUrlBatch(input: string): SubscriptionUrlBatch {
  const seen = new Set<string>();
  const urls: string[] = [];
  let duplicateCount = 0;

  // long: 同一批次按完整 URL 去重并保留首次出现顺序，避免重复请求同一个订阅端点。
  for (const line of input.split(/\r?\n/)) {
    const url = line.trim();
    if (!url) continue;
    if (seen.has(url)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(url);
    urls.push(url);
  }

  return { urls, duplicateCount };
}

export function formatSubscriptionImportFailures(failures: SubscriptionImportFailure[], limit = 2): string {
  const visible = failures.slice(0, limit).map(({ url, error }) => {
    let label = url;
    try {
      label = new URL(url).hostname;
    } catch {
      // long: 无效 URL 保留原始输入，方便用户直接定位需要修正的行。
    }
    return `${label}：${error}`;
  });
  if (failures.length > limit) visible.push(`另 ${failures.length - limit} 条`);
  return visible.join("；");
}
