import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

export const SESSION_COOKIE = "subconvert_session";
export const SESSION_SECONDS = 12 * 60 * 60;
const deriveKey = promisify(scrypt);
type Session = { expiresAt: number; passwordHash: string };
type AuthState = { sessions: Map<string, Session>; attempts: number[]; checking: number };
// long: 页面与登录 API 分属不同路由包，进程级会话让它们共享登录状态；重启清空会话，不能误用旧 Cookie。
const processState = globalThis as typeof globalThis & { __subconvertAuth?: AuthState };
const state = processState.__subconvertAuth ??= { sessions: new Map(), attempts: [], checking: 0 };

export function passwordConfiguration(): string | null {
  const hash = process.env.SUBCONVERT_ACCESS_PASSWORD_HASH;
  return hash && /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash) ? hash : null;
}

export async function verifyPassword(password: string): Promise<boolean> {
  const configured = passwordConfiguration();
  if (!configured || password.length > 256) return false;
  const [, salt, expected] = configured.split(":");
  const actual = await deriveKey(password, salt, 64) as Buffer;
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}

function sessionKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createSession(): string {
  const passwordHash = passwordConfiguration();
  if (!passwordHash) throw new Error("访问密码尚未配置");
  for (const [key, session] of state.sessions) if (session.expiresAt <= Date.now()) state.sessions.delete(key);
  if (state.sessions.size >= 128) state.sessions.delete(state.sessions.keys().next().value!);
  const token = randomBytes(32).toString("hex");
  state.sessions.set(sessionKey(token), { expiresAt: Date.now() + SESSION_SECONDS * 1000, passwordHash });
  return token;
}

export function hasSession(token: string | undefined): boolean {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
  const key = sessionKey(token);
  const session = state.sessions.get(key);
  if (!session) return false;
  // long: 修改密码立即作废当前进程中的旧会话，不允许拿旧密码签发的 Cookie 继续操作订阅和测速。
  if (session.expiresAt <= Date.now() || session.passwordHash !== passwordConfiguration()) {
    state.sessions.delete(key);
    return false;
  }
  return true;
}

export function requestSession(request: Request): string | undefined {
  return request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
}

export function deleteSession(request: Request): void {
  const token = requestSession(request);
  if (token) state.sessions.delete(sessionKey(token));
}

export function requireSession(request: Request): Response | null {
  if (!passwordConfiguration()) return Response.json({ ok: false, error: "访问密码尚未初始化，请使用 npm start 或 npm run dev 启动应用" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  if (hasSession(requestSession(request))) return null;
  return Response.json({ ok: false, error: "请先登录；若会话已过期，可在新标签页登录后重试，当前配置仍保留" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

export function beginLoginAttempt(): boolean {
  // long: 个人工作台统一限制验证频率和并行计算，不能信任调用方可伪造的转发 IP 来绕过密码尝试限制。
  state.attempts = state.attempts.filter((time) => time > Date.now() - 60_000);
  if (state.attempts.length >= 10 || state.checking >= 2) return false;
  state.attempts.push(Date.now());
  state.checking++;
  return true;
}

export function endLoginAttempt(): void {
  state.checking--;
}
