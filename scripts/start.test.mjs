import { test } from "node:test";
import assert from "node:assert/strict";
import { startConfiguration } from "./start.mjs";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("本地默认值与局域网监听配置", () => {
  assert.deepEqual(startConfiguration({}), { host: "127.0.0.1", port: "3010" });
  assert.deepEqual(startConfiguration({ SUBCONVERT_HOST: "192.168.1.2", PORT: "9999" }), { host: "192.168.1.2", port: "9999" });
});

test("拒绝无效生产端口", () => {
  for (const port of ["0", "65536", "9999oops", "-1", "3.5"]) {
    assert.throws(() => startConfiguration({ PORT: port }), /PORT/);
  }
});

test("通过发布软链接启动时仍执行入口", () => {
  const directory = mkdtempSync(join(tmpdir(), "subconvert-start-test-"));
  try {
    const entry = join(directory, "start.mjs");
    symlinkSync(fileURLToPath(new URL("./start.mjs", import.meta.url)), entry);
    const result = spawnSync(process.execPath, [entry], { env: { ...process.env, PORT: "0" }, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PORT 必须/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
