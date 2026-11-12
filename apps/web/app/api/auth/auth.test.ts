import { scryptSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, hasSession, requireSession, SESSION_COOKIE, SESSION_SECONDS, verifyPassword } from "@/lib/auth";
import { POST as login } from "./login/route";
import { POST as logout } from "./logout/route";
import { POST as exportFile } from "../export/route";
import { POST as importSource } from "../import/route";
import { POST as testNodes } from "../node-test/route";
import { GET as download } from "../export/[id]/[fileName]/route";

const password = "test-access-password-123";
const salt = "0123456789abcdef0123456789abcdef";
const hash = `scrypt:${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
let clock = Date.now();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(clock += 120_000);
  vi.stubEnv("SUBCONVERT_ACCESS_PASSWORD_HASH", hash);
});
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

function loginRequest(value: unknown, headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3010/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ password: value }) });
}

describe("访问密码与工作台会话", () => {
  it("正确密码签发 HttpOnly Cookie，错误密码不签发", async () => {
    const wrong = await login(loginRequest("wrong-password"));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.has("Set-Cookie")).toBe(false);
    const correct = await login(loginRequest(password));
    expect(correct.status).toBe(200);
    const cookie = correct.headers.get("Set-Cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=strict");
    expect(cookie).toContain(`Max-Age=${SESSION_SECONDS}`);
    expect(cookie).not.toContain(password);
    expect(requireSession(new Request("http://127.0.0.1:3010", { headers: { Cookie: cookie.split(";")[0] } }))).toBeNull();
  });

  it("未登录时三种业务接口均在读取正文前拒绝，未初始化时也不会放行", async () => {
    for (const endpoint of [exportFile, importSource, testNodes]) {
      const response = await endpoint(new Request("http://127.0.0.1:3010/api/unused", { method: "POST", body: "invalid" }));
      expect(response.status).toBe(401);
    }
    vi.stubEnv("SUBCONVERT_ACCESS_PASSWORD_HASH", "");
    expect((await login(loginRequest(password))).status).toBe(503);
    expect(requireSession(new Request("http://127.0.0.1:3010"))?.status).toBe(503);
  });

  it("会话不接受伪造或篡改的 Cookie，固定十二小时后失效", () => {
    const token = createSession();
    expect(hasSession(token)).toBe(true);
    expect(hasSession(`${token.slice(0, -1)}z`)).toBe(false);
    expect(hasSession("0".repeat(64))).toBe(false);
    vi.advanceTimersByTime(SESSION_SECONDS * 1000);
    expect(hasSession(token)).toBe(false);
  });

  it("退出使服务端旧 Cookie 同步作废，不影响已经签发的十分钟配置链接", async () => {
    const token = createSession();
    const headers = { Cookie: `${SESSION_COOKIE}=${token}`, "Content-Type": "application/x-www-form-urlencoded" };
    const prepared = await exportFile(new Request("http://127.0.0.1:3010/api/export", { method: "POST", headers, body: new URLSearchParams({ payload: JSON.stringify({ content: "proxies: []\n", fileName: "配置.yaml", format: "yaml" }) }) }));
    expect(prepared.status).toBe(200);
    const { url } = await prepared.json();
    const response = await logout(new Request("http://127.0.0.1:3010/api/auth/logout", { method: "POST", headers }));
    expect(response.status).toBe(200);
    expect(hasSession(token)).toBe(false);
    const [, , , id, fileName] = url.split("/");
    const read = () => download(new Request(`http://127.0.0.1:3010${url}`), { params: Promise.resolve({ id, fileName: decodeURIComponent(fileName) }) });
    expect(await (await read()).text()).toBe("proxies: []\n");
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect((await read()).status).toBe(404);
  });

  it("更新访问密码配置使旧会话立即失效", () => {
    const token = createSession();
    vi.stubEnv("SUBCONVERT_ACCESS_PASSWORD_HASH", `scrypt:${"a".repeat(32)}:${"b".repeat(128)}`);
    expect(hasSession(token)).toBe(false);
  });

  it("跨站登录和退出被拒绝，即使访问密码正确也不能签发 Cookie", async () => {
    expect((await login(loginRequest(password, { Origin: "http://evil.example" }))).status).toBe(403);
    expect((await logout(new Request("http://127.0.0.1:3010/api/auth/logout", { method: "POST", headers: { Origin: "http://evil.example" } }))).status).toBe(403);
  });

  it("密码校验不裁剪空白，不接受不合法的密码配置", async () => {
    expect(await verifyPassword(password)).toBe(true);
    expect(await verifyPassword(` ${password}`)).toBe(false);
    vi.stubEnv("SUBCONVERT_ACCESS_PASSWORD_HASH", "broken");
    expect(await verifyPassword(password)).toBe(false);
  });

  it("限制每分钟十次尝试，伪造转发 IP 不会重置限制", async () => {
    for (let index = 0; index < 10; index++) expect((await login(loginRequest("bad", { "X-Forwarded-For": `1.1.1.${index}` }))).status).toBe(401);
    const blocked = await login(loginRequest(password));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    vi.advanceTimersByTime(60_001);
    expect((await login(loginRequest(password))).status).toBe(200);
  });

  it("超长请求、空密码和非法 JSON 不签发会话", async () => {
    expect((await login(loginRequest("x".repeat(5000)))).status).toBe(413);
    expect((await login(loginRequest(""))).status).toBe(400);
    expect((await login(new Request("http://127.0.0.1:3010/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "[" }))).status).toBe(400);
  });

  it("两个未发送完的登录请求在五秒后释放验证槽，不会阻塞正常登录", async () => {
    const slowRequest = () => login(new Request("http://127.0.0.1:3010/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: new ReadableStream(), ...{ duplex: "half" },
    }));
    const first = slowRequest();
    const second = slowRequest();
    expect((await login(loginRequest(password))).status).toBe(429);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await first).status).toBe(408);
    expect((await second).status).toBe(408);
    expect((await login(loginRequest(password))).status).toBe(200);
  });
});
