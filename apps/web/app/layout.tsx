import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SubConvert Lite",
  description: "本地文件式 Clash/Mihomo 订阅转换工作台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
