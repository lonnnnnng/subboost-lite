"use client";

import { Fragment, useMemo } from "react";
import type { ReactNode } from "react";

const YAML_RENDER_LIMITS = {
  lineCount: 2500,
  charCount: 300_000,
  longestLine: 4000,
} as const;

type TokenKind = "key" | "string" | "number" | "boolean" | "null" | "comment" | "punctuation" | "type";

function token(kind: TokenKind, value: string, key: string): ReactNode {
  return <span className={`yaml-token yaml-token-${kind}`} key={key}>{value}</span>;
}

function findOutsideQuotes(value: string, target: string): number {
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === target) return index;
  }
  return -1;
}

function highlightScalar(rawValue: string, lineIndex: number): ReactNode[] {
  const commentIndex = findOutsideQuotes(rawValue, "#");
  const value = commentIndex >= 0 ? rawValue.slice(0, commentIndex) : rawValue;
  const comment = commentIndex >= 0 ? rawValue.slice(commentIndex) : "";
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const scalar = value.trim();
  const result: ReactNode[] = [leading];

  if (!scalar) {
    result.push(trailing);
  } else if (/^["'].*["']$/.test(scalar)) {
    result.push(token("string", scalar, `${lineIndex}-string`), trailing);
  } else if (/^-?\d+(?:\.\d+)?$/.test(scalar)) {
    result.push(token("number", scalar, `${lineIndex}-number`), trailing);
  } else if (/^(?:true|false)$/i.test(scalar)) {
    result.push(token("boolean", scalar, `${lineIndex}-boolean`), trailing);
  } else if (/^(?:null|~)$/i.test(scalar)) {
    result.push(token("null", scalar, `${lineIndex}-null`), trailing);
  } else if (/^(?:ss|ssr|vmess|vless|trojan|anytls|hysteria|hysteria2|hy2|tuic|wireguard|socks4|socks5|http|https|ssh|relay)$/i.test(scalar)) {
    result.push(token("type", scalar, `${lineIndex}-type`), trailing);
  } else if (/^[\[{].*[\]}]$/.test(scalar)) {
    const pieces = scalar.split(/([\[\]{},])/g).filter(Boolean);
    result.push(...pieces.map((piece, index) => /[\[\]{},]/.test(piece)
      ? token("punctuation", piece, `${lineIndex}-punctuation-${index}`)
      : <Fragment key={`${lineIndex}-inline-${index}`}>{piece}</Fragment>), trailing);
  } else {
    result.push(token("string", scalar, `${lineIndex}-plain`), trailing);
  }

  if (comment) result.push(token("comment", comment, `${lineIndex}-comment`));
  return result;
}

function highlightLine(line: string, lineIndex: number): ReactNode {
  if (!line.trim()) return " ";
  if (line.trimStart().startsWith("#")) return token("comment", line, `${lineIndex}-comment-line`);

  const sequenceMatch = line.match(/^(\s*)(-)(\s+)(.*)$/);
  const indent = sequenceMatch?.[1] ?? line.match(/^\s*/)?.[0] ?? "";
  const dash = sequenceMatch?.[2] ?? "";
  const spacing = sequenceMatch?.[3] ?? "";
  const content = sequenceMatch?.[4] ?? line.slice(indent.length);
  const colonIndex = findOutsideQuotes(content, ":");

  if (colonIndex < 0) {
    return <>{indent}{dash ? token("punctuation", dash, `${lineIndex}-dash`) : null}{spacing}{highlightScalar(content, lineIndex)}</>;
  }

  const key = content.slice(0, colonIndex);
  const value = content.slice(colonIndex + 1);
  return (
    <>
      {indent}
      {dash ? token("punctuation", dash, `${lineIndex}-dash`) : null}
      {spacing}
      {token("key", key, `${lineIndex}-key`)}
      {token("punctuation", ":", `${lineIndex}-colon`)}
      {highlightScalar(value, lineIndex)}
    </>
  );
}

function shouldRenderPlain(content: string): boolean {
  const lines = content.split("\n");
  return lines.length > YAML_RENDER_LIMITS.lineCount
    || content.length > YAML_RENDER_LIMITS.charCount
    || lines.some((line) => line.length > YAML_RENDER_LIMITS.longestLine);
}

export function YamlHighlight({ content }: { content: string }) {
  const plain = useMemo(() => shouldRenderPlain(content), [content]);
  const lines = useMemo(() => plain ? [] : content.split("\n"), [content, plain]);

  if (plain) {
    return (
      <div className="yaml-highlight">
        <div className="yaml-large-notice">YAML 内容较大，已使用纯文本预览以保持页面流畅。</div>
        <pre className="yaml-preview yaml-preview-plain"><code>{content}</code></pre>
      </div>
    );
  }

  return (
    <div className="yaml-highlight" aria-label="YAML 语法高亮预览">
      <pre className="yaml-preview">
        <code>
          {lines.map((line, index) => (
            <span className="yaml-line" key={`${index}-${line}`}>
              <span className="yaml-line-number" aria-hidden="true">{index + 1}</span>
              <span className="yaml-line-content">{highlightLine(line, index)}</span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
