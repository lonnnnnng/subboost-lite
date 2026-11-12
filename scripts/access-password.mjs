import { constants, closeSync, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, scryptSync } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export function prepareAccessPassword(env = process.env) {
  const path = env.SUBCONVERT_PASSWORD_FILE || resolve(projectRoot, ".access-password");
  if (!path.startsWith("/")) throw new Error("SUBCONVERT_PASSWORD_FILE 必须是绝对路径");
  // long: 仅首次启动创建，使用排他打开避免并发启动覆盖密码；密码不进入命令行、源码或启动日志。
  let created = false;
  try {
    const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(descriptor, `${randomBytes(24).toString("base64url")}\n`); } finally { closeSync(descriptor); }
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw new Error(`无法创建访问密码文件：${path}，请检查目录权限`);
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let password;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 1024 || (stat.mode & 0o077) !== 0) throw new Error(`访问密码文件必须是权限 600 的普通文件：${path}`);
    password = readFileSync(descriptor, "utf8").replace(/\r?\n$/, "");
  } finally { closeSync(descriptor); }
  if (password.length < 12 || password.length > 256 || /[\r\n]/.test(password)) throw new Error(`访问密码文件须为单行 12-256 个字符：${path}`);
  const salt = randomBytes(16).toString("hex");
  return { path, created, hash: `scrypt:${salt}:${scryptSync(password, salt, 64).toString("hex")}` };
}
