import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@subboost/core", "@subboost/server-core"],
  // long: 浏览器工作台已有完整状态反馈，隐藏只用于框架调试的左下角入口，避免干扰正式界面。
  devIndicators: false,
};

export default nextConfig;
