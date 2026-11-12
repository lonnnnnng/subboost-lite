import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareAccessPassword } from "./access-password.mjs";

const webDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/web");
const require = createRequire(resolve(webDirectory, "package.json"));

export function startConfiguration(env = process.env) {
  const host = env.SUBCONVERT_HOST?.trim() || "127.0.0.1";
  const port = env.PORT?.trim() || "3010";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("PORT 必须是 1-65535 的整数");
  }
  return { host, port };
}

function start() {
  const { host, port } = startConfiguration();
  const access = prepareAccessPassword();
  const development = process.argv.includes("--dev");
  console.log(`${access.created ? "已生成" : "已读取"}访问密码文件：${access.path}`);
  // long: 显式传递监听地址和端口，既保留本地默认值，也避免生产服务仍被脚本锁在回环地址。
  const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), development ? "dev" : "start", webDirectory, "--hostname", host, "--port", port], {
    cwd: webDirectory,
    stdio: "inherit",
    env: { ...process.env, SUBCONVERT_ACCESS_PASSWORD_HASH: access.hash, NODE_ENV: development ? "development" : "production" },
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.once("error", (error) => {
    console.error(`启动失败：${error.message}`);
    process.exitCode = 1;
  });
  // long: 服务管理器需要收到 Next 的真实退出结果，不能在子进程已失败时仍把启动器视为正常运行。
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1);
  });
}

// long: 发布目录通过 current 软链接切换，ESM 会解析真实路径；比较时也必须解析 argv，避免服务静默退出。
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) start();
