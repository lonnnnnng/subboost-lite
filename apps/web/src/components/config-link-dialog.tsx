"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Clipboard, LoaderCircle, RotateCcw, X } from "lucide-react";
import QRCode from "qrcode";
import { prepareExport } from "@/lib/download";
import { copyText } from "@/lib/clipboard";

export function ConfigLinkDialog({ content, fileName, onClose }: { content: string; fileName: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [generation, setGeneration] = useState(0);
  const [file, setFile] = useState<{ url: string; expiresAt: number } | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now);
  const remaining = file ? Math.max(0, Math.ceil((file.expiresAt - now) / 1000)) : 0;

  useEffect(() => {
    const dialog = dialogRef.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    // long: React 卸载原生弹框时也主动关闭并恢复触发按钮焦点，键盘用户不应掉回页面起点。
    return () => { dialog?.close(); trigger?.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // long: 固定为打开弹框时的配置快照，之后修改页面不会悄悄改变已经交给客户端的链接内容。
    void prepareExport(content, fileName, "yaml", AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])).then((prepared) => {
      if (!controller.signal.aborted) { setFile(prepared); setNow(Date.now()); }
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "生成失败，请重试");
    }).finally(() => { if (!controller.signal.aborted) setPending(false); });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [content, fileName, generation]);

  useEffect(() => {
    if (!file || !canvasRef.current) return;
    // long: 二维码只在本地编码随机配置地址，不请求外部二维码服务，避免把节点访问令牌交给第三方。
    void QRCode.toCanvas(canvasRef.current, file.url, { width: 240, margin: 4, errorCorrectionLevel: "M" }).catch(() => setError("二维码生成失败，仍可复制链接使用"));
  }, [file]);

  async function copyLink() {
    if (!file) return;
    try { await copyText(file.url); setCopied(true); } catch { setError("复制失败，请选中上方链接手动复制"); }
  }

  return (
    <dialog className="config-link-dialog" ref={dialogRef} onCancel={(event) => { event.preventDefault(); onClose(); }} aria-labelledby="config-link-title" aria-describedby="config-link-description">
      <div className="config-link-heading"><h2 id="config-link-title">临时配置链接</h2><button className="icon-button compact" type="button" onClick={onClose} aria-label="关闭临时链接"><X size={17} /></button></div>
      <p id="config-link-description">复制链接，或用客户端扫描二维码导入。链接固定有效 10 分钟。</p>
      {pending ? <div className="config-link-loading" role="status"><LoaderCircle className="spin" size={22} />正在生成配置链接…</div> : null}
      <div className={`config-link-body ${remaining === 0 ? "is-expired" : ""}`} hidden={!file || pending}>
        <div className="config-link-fields">
          <label htmlFor="config-link-url">HTTP 配置地址</label>
          <textarea id="config-link-url" readOnly value={file?.url ?? ""} spellCheck={false} rows={4} onFocus={(event) => event.currentTarget.select()} />
          <p className={`config-link-expiry ${remaining === 0 ? "expired" : ""}`}>{remaining > 0 ? `剩余 ${Math.floor(remaining / 60)} 分 ${String(remaining % 60).padStart(2, "0")} 秒 · ${new Date(file!.expiresAt).toLocaleTimeString("zh-CN", { hour12: false })} 到期` : "链接已过期，请重新生成"}</p>
          <button className="primary-button" type="button" onClick={() => void copyLink()} disabled={!remaining}>{copied ? <Check size={16} /> : <Clipboard size={16} />}{copied ? "已复制链接" : "复制链接"}</button>
        </div>
        <div className="config-link-qr"><canvas ref={canvasRef} role="img" aria-label="配置链接二维码" /><span>{remaining ? "在同一网络下扫描导入" : "二维码已过期"}</span></div>
      </div>
      {error ? <p className="config-link-error" role="alert">{error}</p> : null}
      <p className="config-link-note">链接包含当前配置快照。请勿分享给他人；服务重启后链接会失效。</p>
      <div className="config-link-footer"><button className="secondary-button" type="button" onClick={() => { setPending(true); setError(""); setCopied(false); setGeneration((value) => value + 1); }} disabled={pending}><RotateCcw size={15} />重新生成</button><button className="secondary-button" type="button" onClick={onClose}>完成</button></div>
    </dialog>
  );
}
