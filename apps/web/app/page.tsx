import { Workbench } from "@/components/workbench";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { hasSession, SESSION_COOKIE } from "@/lib/auth";

export default async function Home() {
  if (!hasSession((await cookies()).get(SESSION_COOKIE)?.value)) redirect("/login");
  return <Workbench />;
}
