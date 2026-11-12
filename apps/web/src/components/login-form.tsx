"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight, Eye, EyeOff, LoaderCircle, LockKeyhole } from "lucide-react";

export function LoginForm({ configured }: { configured: boolean }) {
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }), signal: AbortSignal.timeout(15_000) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "登录失败，请重试");
      window.location.replace("/");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "连接失败，请重试");
      setPending(false);
    }
  }

  return (
    <main className="login-page">
      <header className="login-brand"><span className="brand-mark" aria-hidden="true">S/</span><strong>SubConvert Lite</strong></header>
      <section className="login-panel" aria-labelledby="login-title">
        <LockKeyhole className="login-lock" size={28} aria-hidden="true" />
        <h1 id="login-title">登录工作台</h1>
        <p className="login-description">输入访问密码，继续配置你的网络。</p>
        {configured ? (
          <form onSubmit={(event) => void login(event)}>
            <label htmlFor="access-password">访问密码</label>
            <div className="login-password-field">
              <input id="access-password" name="password" type={visible ? "text" : "password"} autoComplete="current-password" autoFocus required maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} disabled={pending} aria-describedby={error ? "login-error" : undefined} aria-invalid={Boolean(error)} />
              <button className="icon-button" type="button" onClick={() => setVisible(!visible)} aria-label={visible ? "隐藏密码" : "显示密码"}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button>
            </div>
            {error ? <p className="login-error" id="login-error" role="alert">{error}</p> : null}
            <button className="primary-button login-submit" type="submit" disabled={pending || !password}>{pending ? <LoaderCircle className="spin" size={17} /> : null}{pending ? "正在登录…" : "进入工作台"}{!pending ? <ArrowRight size={17} /> : null}</button>
          </form>
        ) : <p className="login-error" role="alert">访问密码尚未初始化。请使用 npm start 或 npm run dev 启动应用。</p>}
        <p className="login-hint">密码保存在服务器的隐藏文件中，启动日志会显示文件位置。</p>
      </section>
      <footer className="login-footer">Clash / Mihomo 配置工作台</footer>
    </main>
  );
}
