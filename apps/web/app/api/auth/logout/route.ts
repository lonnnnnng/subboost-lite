import { NextResponse } from "next/server";
import { isAllowedApiRequest } from "@/lib/api-access";
import { deleteSession, SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isAllowedApiRequest(request)) return NextResponse.json({ ok: false, error: "请求不是同源" }, { status: 403 });
  // long: 退出同时回收服务端会话，已复制的旧 Cookie 也不能再用于导入和测速。
  deleteSession(request);
  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "strict", secure: new URL(request.url).protocol === "https:", path: "/", maxAge: 0 });
  return response;
}
