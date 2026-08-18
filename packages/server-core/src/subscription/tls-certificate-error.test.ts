import { describe, expect, it } from "vitest";
import { isTlsCertificateError } from "./tls-certificate-error";

describe("isTlsCertificateError", () => {
  it("accepts certificate expiry, trust-chain, and hostname errors", () => {
    expect(isTlsCertificateError({ code: "CERT_HAS_EXPIRED" })).toBe(true);
    expect(isTlsCertificateError({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })).toBe(true);
    expect(isTlsCertificateError("certificate has expired")).toBe(true);
    expect(isTlsCertificateError("self-signed certificate in certificate chain")).toBe(true);
    expect(
      isTlsCertificateError(
        "Hostname/IP does not match certificate's altnames: IP: [IP] is not in the cert's list:"
      )
    ).toBe(true);
  });

  it("does not treat unrelated transport failures as certificate failures", () => {
    expect(isTlsCertificateError({ code: "ECONNREFUSED", message: "connect refused" })).toBe(false);
    expect(isTlsCertificateError({ code: "ERR_SSL_WRONG_VERSION_NUMBER" })).toBe(false);
    expect(isTlsCertificateError("socket hang up")).toBe(false);
  });
});
