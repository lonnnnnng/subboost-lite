import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "scripts/**"] },
  resolve: {
    // long: 接口测试既包含真实工具函数也包含 mock，统一解析 Next 的路径别名，避免只在 mock 命中时测试才能加载。
    alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) },
  },
});
