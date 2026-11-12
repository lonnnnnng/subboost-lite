import { NextResponse } from "next/server";
import { isAllowedApiRequest } from "@/lib/api-access";
import { beginLoginAttempt, createSession, endLoginAttempt, passwordConfiguration, SESSION_COOKIE, SESSION_SECONDS, verifyPassword } from "@/lib/auth";

export const runtime = "nodejs";

function error(message: string, status: number) {
  return NextResponse.json({ ok: false, error: message }, { status, headers: { "Cache-Control": "no-store", ...(status === 429 ? { "Retry-After": "60" } : {}) } });
}

export async function POST(request: Request) {
  if (!isAllowedApiRequest(request)) return error("当前访问地址未获允许或请求不是同源", 403);
  if (!passwordConfiguration()) return error("访问密码尚未初始化，请使用 npm start 或 npm run dev 启动应用", 503);
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) return error("请求格式无效", 415);
  if (!beginLoginAttempt()) return error("尝试过于频繁，请一分钟后重试", 429);
  try {
    // long: 登录只接收短密码，读取中限制正文大小，防止未登录请求用大 JSON 消耗内存。
    if (!request.body) return error("请输入访问密码", 400);
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    let stop!: () => void;
    // long: 未登录的慢请求不能一直占着全局验证槽；总读取期限固定五秒，超时或断开都及时释放。
    const interrupted = new Promise<never>((_, reject) => {
      stop = () => { reject(new Error("登录请求读取中止")); void reader.cancel().catch(() => undefined); };
    });
    const timer = setTimeout(stop, 5000);
    request.signal.addEventListener("abort", stop, { once: true });
    if (request.signal.aborted) stop();
    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), interrupted]);
        if (done) break;
        length += value.length;
        if (length > 4096) {
          void reader.cancel().catch(() => undefined);
          return error("登录请求过大", 413);
        }
        chunks.push(value);
      }
    } catch {
      return error("登录请求读取超时或连接已断开，请重试", 408);
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", stop);
      reader.releaseLock();
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks, length).toString("utf8")); } catch { return error("请求内容无效", 400); }
    const password = (body as { password?: unknown })?.password;
    if (typeof password !== "string" || !password || password.length > 256) return error("请输入有效的访问密码", 400);
    if (!await verifyPassword(password)) return error("访问密码不正确，请重试", 401);
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(SESSION_COOKIE, createSession(), { httpOnly: true, sameSite: "strict", secure: new URL(request.url).protocol === "https:", path: "/", maxAge: SESSION_SECONDS });
    return response;
  } finally {
    endLoginAttempt();
  }
}
