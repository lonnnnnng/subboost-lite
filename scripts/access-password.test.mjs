import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scryptSync } from "node:crypto";
import { prepareAccessPassword } from "./access-password.mjs";

test("首次启动生成隐藏密码，重启不更换，校验材料中不含明文密码", () => {
  const directory = mkdtempSync(join(tmpdir(), "subconvert-password-test-"));
  try {
    const path = join(directory, ".access-password");
    const first = prepareAccessPassword({ SUBCONVERT_PASSWORD_FILE: path });
    const password = readFileSync(path, "utf8").trimEnd();
    assert.equal(first.created, true);
    assert.equal(password.length, 32);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const second = prepareAccessPassword({ SUBCONVERT_PASSWORD_FILE: path });
    assert.equal(second.created, false);
    assert.equal(readFileSync(path, "utf8").trimEnd(), password);
    const [, salt, derived] = second.hash.split(":");
    assert.equal(scryptSync(password, salt, 64).toString("hex"), derived);
    assert.ok(!second.hash.includes(password));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("密码文件权限过宽、符号链接或非法内容时停止启动，不默默生成新密码", () => {
  const directory = mkdtempSync(join(tmpdir(), "subconvert-password-test-"));
  try {
    const path = join(directory, ".access-password");
    writeFileSync(path, "existing-access-password\n", { mode: 0o644 });
    assert.throws(() => prepareAccessPassword({ SUBCONVERT_PASSWORD_FILE: path }), /权限 600/);
    chmodSync(path, 0o600);
    const linked = join(directory, "linked");
    symlinkSync(path, linked);
    assert.throws(() => prepareAccessPassword({ SUBCONVERT_PASSWORD_FILE: linked }));
    writeFileSync(path, "short\n");
    assert.throws(() => prepareAccessPassword({ SUBCONVERT_PASSWORD_FILE: path }), /12-256/);
    assert.throws(() => prepareAccessPassword({ SUBCONVERT_PASSWORD_FILE: "relative" }), /绝对路径/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
