import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { hasSession, passwordConfiguration, SESSION_COOKIE } from "@/lib/auth";

export default async function LoginPage() {
  if (hasSession((await cookies()).get(SESSION_COOKIE)?.value)) redirect("/");
  return <LoginForm configured={Boolean(passwordConfiguration())} />;
}
