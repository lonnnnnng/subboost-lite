import { describe, expect, it } from "vitest";
import {
  dedupeParsedNodes,
  inferParseErrorCategory,
  normalizeParseErrors,
  normalizeParseResult,
} from "./normalize";
import type { ParsedNode } from "@subboost/core/types/node";

function node(name: string, server = "ss.example.com"): ParsedNode {
  return {
    name,
    type: "ss",
    server,
    port: 8388,
    cipher: "aes-128-gcm",
    password: "secret",
  } as ParsedNode;
}

describe("parse result normalization", () => {
  it("categorizes and dedupes parse errors", () => {
    expect(inferParseErrorCategory("不能为空")).toBe("empty");
    expect(inferParseErrorCategory("检测到 HTML 错误页")).toBe("html");
    expect(inferParseErrorCategory("YAML 解析错误")).toBe("yaml");
    expect(inferParseErrorCategory("客户端更新提示占位")).toBe("placeholder");
    expect(inferParseErrorCategory("不支持的协议: ftp")).toBe("unsupported-scheme");
    expect(inferParseErrorCategory("无法识别格式")).toBe("unsupported-format");
    expect(inferParseErrorCategory("")).toBe("unknown");
    expect(normalizeParseErrors([" a ", "", "a", "b"])).toEqual(["a", "b"]);
  });

  it("dedupes parsed nodes and carries prior errors into final results", () => {
    expect(dedupeParsedNodes([node("A"), node("A"), node("B", "b.example.com")])).toMatchObject({
      dedupedCount: 1,
      nodes: [{ name: "A" }, { name: "B" }],
    });

    const result = normalizeParseResult(
      {
        nodes: [node("A"), node("A"), node("B", "b.example.com")],
        errors: [" current "],
        totalParsed: 3,
        totalFailed: 1,
      },
      ["prior", "current"]
    );

    expect(result.nodes).toHaveLength(2);
    expect(result.errors).toEqual(["prior", "current"]);
    expect(result.totalParsed).toBe(2);
    expect(result.totalFailed).toBe(2);
  });

  it("preserves and deduplicates direct-domain metadata", () => {
    const result = normalizeParseResult({
      nodes: [node("A")],
      errors: [],
      totalParsed: 1,
      totalFailed: 0,
      directDomains: [
        { domain: " Corp.Example.com ", nameservers: ["10.0.0.53", "10.0.0.53"] },
        { domain: "corp.example.com", nameservers: ["10.0.0.54"] },
      ],
    });

    expect(result.directDomains).toEqual([
      { domain: "corp.example.com", nameservers: ["10.0.0.53", "10.0.0.54"] },
    ]);
  });
});
