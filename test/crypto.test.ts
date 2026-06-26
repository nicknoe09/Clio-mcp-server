import { describe, it, expect } from "vitest";

// Fixed vector produced by the platform's crypto scheme (pyca/cryptography
// AESGCM envelope encryption) — see app/crypto.py. This locks in byte-layout
// parity: Node must decrypt exactly what Python produced (tag appended to the
// ciphertext, DEK wrapped as [nonce || ct || tag] with AAD "dek", token AAD
// `noe-reminders:<userId>:clio:<field>`).
const VECTOR = {
  kek_b64: "8T2Y/bzV0Ynapf8U/T2PnfrX/srmL3hlwe+JJ9MZLWM=",
  user_id: "42",
  access: {
    plaintext: "clio-access-token-VALUE-12345",
    aad: "noe-reminders:42:clio:access_token",
    ct: "f8TDIceIpeCFCXxqH5jo8LLqCbpcZbfI5WkTR6C/Fovwe+vnAeT09nvErhka",
    nonce: "ZVE0nfTuchETBiH8",
    dek_ct: "vUk1O2vMWJp6EvZzsA87hlAyIvhS5H1mACESMskRv296PzkWF1fEnko5j+ExIviu9f1C8O7EcnQUcSAt",
  },
  refresh: {
    plaintext: "clio-refresh-token-VALUE-67890",
    aad: "noe-reminders:42:clio:refresh_token",
    ct: "dFfAjfaZX6JzxjaQKjgg0Y6tbbuJ4V0NmMBKQvX7Lv4Ne8RWpIDr7kiItBPZkw==",
    nonce: "z7HrqyzMT2xHA+yU",
    dek_ct: "H4p6UlNLFvB1m3hK11X2ziRs5qcUn2NrI6QwtV7eAF+IxZNHfbm58LIGIj+e49XtC7HQ2lRPXpFdOE2G",
  },
};

// crypto.ts reads APP_KEK_B64 from the environment lazily; set it before import.
process.env.APP_KEK_B64 = VECTOR.kek_b64;

import { decryptToken, encryptToken, tokenAad, EncryptedField } from "../src/auth/crypto";

function field(v: { ct: string; nonce: string; dek_ct: string }): EncryptedField {
  return {
    ct: Buffer.from(v.ct, "base64"),
    nonce: Buffer.from(v.nonce, "base64"),
    dekCt: Buffer.from(v.dek_ct, "base64"),
  };
}

describe("crypto parity with platform AES-256-GCM envelope encryption", () => {
  it("decrypts a Python-produced access token", () => {
    expect(decryptToken(field(VECTOR.access), VECTOR.access.aad)).toBe(VECTOR.access.plaintext);
  });

  it("decrypts a Python-produced refresh token", () => {
    expect(decryptToken(field(VECTOR.refresh), VECTOR.refresh.aad)).toBe(VECTOR.refresh.plaintext);
  });

  it("builds the token AAD exactly as the platform does", () => {
    expect(tokenAad("42", "access_token")).toBe("noe-reminders:42:clio:access_token");
    expect(tokenAad("42", "refresh_token")).toBe("noe-reminders:42:clio:refresh_token");
  });

  it("scopes the AAD by provider (clio default, box explicit)", () => {
    // Default provider stays clio for backward compatibility.
    expect(tokenAad("42", "access_token")).toBe("noe-reminders:42:clio:access_token");
    // Box gets its own provider segment.
    expect(tokenAad("42", "access_token", "box")).toBe("noe-reminders:42:box:access_token");
    expect(tokenAad("42", "refresh_token", "box")).toBe("noe-reminders:42:box:refresh_token");
  });

  it("round-trips a box-scoped token but won't cross-decrypt with clio's AAD", () => {
    const boxAad = tokenAad("7", "access_token", "box");
    const enc = encryptToken("box-access-token-VALUE", boxAad);
    expect(decryptToken(enc, boxAad)).toBe("box-access-token-VALUE");
    // Same field + user but clio provider must NOT decrypt a box token.
    expect(() => decryptToken(enc, tokenAad("7", "access_token", "clio"))).toThrow();
  });

  it("round-trips encrypt -> decrypt", () => {
    const aad = tokenAad("99", "access_token");
    const secret = "a-fresh-clio-token-🔐-with-unicode";
    const enc = encryptToken(secret, aad);
    expect(decryptToken(enc, aad)).toBe(secret);
  });

  it("fails to decrypt when the AAD does not match (tamper guard)", () => {
    expect(() => decryptToken(field(VECTOR.access), "noe-reminders:42:clio:refresh_token")).toThrow();
  });
});
