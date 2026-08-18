const TLS_CERTIFICATE_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REJECTED",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

const TLS_CERTIFICATE_ERROR_PATTERNS = [
  /certificate has expired/i,
  /certificate is not yet valid/i,
  /certificate.*(?:rejected|revoked|untrusted)/i,
  /self[- ]signed certificate/i,
  /unable to (?:get issuer certificate|verify the first certificate|verify leaf signature)/i,
  /hostname\/ip does not match certificate/i,
  /does not match certificate(?:'s|s)? (?:altnames|subject alternative names)/i,
];

/**
 * long: 只把证书身份或信任链错误交给人工审核，协议版本、连接失败等 TLS 错误仍然直接失败。
 */
export function isTlsCertificateError(input: { code?: string | null; message?: string | null } | string): boolean {
  const code = typeof input === "string" ? "" : input.code?.trim().toUpperCase() || "";
  const message = typeof input === "string" ? input : input.message || "";
  return TLS_CERTIFICATE_ERROR_CODES.has(code) || TLS_CERTIFICATE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
