import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // long: 发布源码副本属于制品，不能再次当作工作区测试执行，否则会重复运行旧代码及 Node 启动测试。
  test: { exclude: [...configDefaults.exclude, "scripts/**", "output/**"] },
  resolve: {
    // long: 接口测试既包含真实工具函数也包含 mock，统一解析 Next 的路径别名，避免只在 mock 命中时测试才能加载。
    alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) },
  },
});
