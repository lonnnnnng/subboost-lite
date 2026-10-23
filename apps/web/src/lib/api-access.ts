function parseOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

export function isAllowedApiRequest(request: Request): boolean {
  const url = new URL(request.url);
  const authority = request.headers.get("host") || url.host;
  const address = parseOrigin(`${url.protocol}//${authority}`);
  if (!address) return false;

  // long: 仅以真实 Host 和显式配置判断入口，不信任可由调用方伪造的 X-Forwarded-Host。
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(address.hostname);
  const configured = (process.env.SUBCONVERT_ALLOWED_ORIGINS || "").split(",")
    .map((value) => parseOrigin(value.trim()))
    .some((allowed) => allowed?.origin === address.origin);
  if (!loopback && !configured) return false;
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;

  const origin = request.headers.get("origin");
  // long: 无 Origin 的同地址命令行请求仍可运维；浏览器请求必须完整匹配协议、域名和端口，防止跨站消耗服务器流量。
  return origin === null || parseOrigin(origin)?.origin === address.origin;
}
