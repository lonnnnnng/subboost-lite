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

export async function runSubscriptionImportWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = SUBSCRIPTION_IMPORT_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    // long: 只把本地定时器触发的中止归类为 15 秒超时，其他网络异常保留原始错误供批量汇总。
    if (controller.signal.aborted) throw new Error(SUBSCRIPTION_IMPORT_TIMEOUT_MESSAGE);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
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
