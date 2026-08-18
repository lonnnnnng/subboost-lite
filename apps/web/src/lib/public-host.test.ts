import type { lookup } from "node:dns/promises";
import { describe, expect, it, vi } from "vitest";
import { resolvePublicHost } from "./public-host";

function lookupResult(addresses: string[]): typeof lookup {
  return vi.fn(async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))) as unknown as typeof lookup;
}

describe("public node host resolver", () => {
  it("rejects local and reserved addresses before connecting", async () => {
    await expect(resolvePublicHost("localhost")).rejects.toThrow("禁止访问本机或内网地址");
    await expect(resolvePublicHost("192.168.1.8")).rejects.toThrow("禁止访问本机或内网地址");
    await expect(resolvePublicHost("[::1]")).rejects.toThrow("禁止访问本机或内网地址");
  });

  it("rejects a hostname when any DNS answer points to a private network", async () => {
    await expect(resolvePublicHost("mixed.example", {
      lookupHost: lookupResult(["1.1.1.1", "10.0.0.8"]),
    })).rejects.toThrow("禁止访问本机或内网地址");
  });

  it("rechecks Fake-IP answers with DoH and returns only verified public addresses", async () => {
    const resolveByDoh = vi.fn(async () => ["93.184.216.34"]);
    await expect(resolvePublicHost("fake-ip.example", {
      lookupHost: lookupResult(["198.18.0.5"]),
      resolveByDoh,
    })).resolves.toEqual(["93.184.216.34"]);
    expect(resolveByDoh).toHaveBeenCalledWith("fake-ip.example", { timeoutMs: 4000 });
  });
});
