import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import type { ParsedNode } from "@subboost/core/types/node";
import { mapWithConcurrency, probeNodeTcp } from "./tcp";

function node(server = "node.example", port = 443): ParsedNode {
  return { name: "test", type: "trojan", server, port, password: "secret" } as ParsedNode;
}

function fakeSocket(event: "connect" | "timeout" | "error", onSetTimeout?: (timeoutMs: number) => void): Socket {
  const socket = new EventEmitter() as Socket;
  socket.setTimeout = ((timeoutMs: number) => {
    onSetTimeout?.(timeoutMs);
    return socket;
  }) as Socket["setTimeout"];
  socket.destroy = (() => socket) as Socket["destroy"];
  queueMicrotask(() => {
    if (event === "error") socket.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
    else socket.emit(event);
  });
  return socket;
}

describe("node TCP probe", () => {
  it("reports a successful connection to the verified pinned address", async () => {
    let now = 100;
    await expect(probeNodeTcp(node(), {
      resolveHost: async () => ["1.1.1.1"],
      connect: (options) => {
        expect(options).toEqual({ host: "1.1.1.1", port: 443, family: 4 });
        now = 137;
        return fakeSocket("connect");
      },
      now: () => now,
    })).resolves.toEqual({ status: "reachable", latencyMs: 37, pinnedServer: "1.1.1.1" });
  });

  it("maps connection failures and blocked hosts to stable public errors", async () => {
    await expect(probeNodeTcp(node(), {
      resolveHost: async () => ["1.1.1.1"],
      connect: () => fakeSocket("error"),
    })).resolves.toEqual({ status: "unreachable", pinnedServer: "1.1.1.1", error: "连接被拒绝" });

    await expect(probeNodeTcp(node("127.0.0.1"), {
      resolveHost: async () => { throw new Error("禁止访问本机或内网地址"); },
    })).resolves.toEqual({ status: "blocked", error: "禁止访问本机或内网地址" });
  });

  it("applies the caller supplied connectivity timeout to the real socket", async () => {
    let appliedTimeout = 0;
    await probeNodeTcp(node(), {
      resolveHost: async () => ["1.1.1.1"],
      connect: () => fakeSocket("connect", (timeoutMs) => { appliedTimeout = timeoutMs; }),
    }, 12_500);

    expect(appliedTimeout).toBe(12_500);
  });

  it("keeps batch output order while respecting the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([30, 5, 15, 1], 2, async (delay, index) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
      return index;
    });

    expect(results).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });
});
