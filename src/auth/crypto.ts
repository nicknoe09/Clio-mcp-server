import crypto from "crypto";
import { ENV } from "../utils/env";

/**
 * AES-256-GCM envelope encryption — byte-for-byte compatible with the
 * platform's `app/crypto.py` (Python `cryptography` AESGCM).
 *
 * Layout produced by the platform and reproduced here:
 *   - A per-row Data Encryption Key (DEK) is wrapped under the master KEK.
 *   - Each token is encrypted under its DEK with a per-field AAD.
 *
 * Critical parity facts (these are the easy things to get wrong):
 *   - Python's AESGCM.encrypt APPENDS the 16-byte auth tag to the ciphertext.
 *     Node's GCM keeps the tag separate, so we split ct = [data || tag] and
 *     call setAuthTag(tag) on decrypt, and Buffer.concat([data, tag]) on encrypt.
 *   - The wrapped DEK is stored as [nonce(12) || ct || tag(16)] with AAD "dek".
 *   - Token AAD is `noe-reminders:${userId}:<provider>:<field>` (provider was
 *     historically always "clio"; it is now explicit so Box — and any future
 *     integration — gets its own AAD and can't be cross-decrypted with Clio).
 */

const TAG_LEN = 16;
const NONCE_LEN = 12;
const DEK_AAD = Buffer.from("dek");

function kek(): Buffer {
  const key = Buffer.from(ENV.APP_KEK_B64, "base64");
  if (key.length !== 32) {
    throw new Error("APP_KEK_B64 must base64-decode to exactly 32 bytes");
  }
  return key;
}

export function tokenAad(
  userId: string,
  field: "access_token" | "refresh_token",
  provider: string = "clio",
): string {
  return `noe-reminders:${userId}:${provider}:${field}`;
}

/** AES-256-GCM decrypt where the ciphertext has the auth tag appended. */
function gcmDecrypt(key: Buffer, iv: Buffer, ctWithTag: Buffer, aad: Buffer): Buffer {
  const data = ctWithTag.subarray(0, ctWithTag.length - TAG_LEN);
  const tag = ctWithTag.subarray(ctWithTag.length - TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/** AES-256-GCM encrypt, returning [ciphertext || tag] (Python AESGCM layout). */
function gcmEncrypt(key: Buffer, iv: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ct, cipher.getAuthTag()]);
}

/** Unwrap a per-row DEK that was wrapped under the KEK as [nonce || ct || tag]. */
function unwrapDek(wrapped: Buffer): Buffer {
  const nonce = wrapped.subarray(0, NONCE_LEN);
  const rest = wrapped.subarray(NONCE_LEN);
  const dek = gcmDecrypt(kek(), nonce, rest, DEK_AAD);
  if (dek.length !== 32) {
    throw new Error("Unwrapped DEK is not 32 bytes");
  }
  return dek;
}

/** Wrap a fresh DEK under the KEK as [nonce || ct || tag]. */
function wrapDek(dek: Buffer): Buffer {
  const nonce = crypto.randomBytes(NONCE_LEN);
  const ct = gcmEncrypt(kek(), nonce, dek, DEK_AAD);
  return Buffer.concat([nonce, ct]);
}

export interface EncryptedField {
  ct: Buffer; // ciphertext with appended tag
  nonce: Buffer; // 12-byte IV
  dekCt: Buffer; // wrapped DEK ([nonce || ct || tag])
}

/** Decrypt a stored token field using its wrapped DEK. */
export function decryptToken(field: EncryptedField, aad: string): string {
  const dek = unwrapDek(field.dekCt);
  const plaintext = gcmDecrypt(dek, field.nonce, field.ct, Buffer.from(aad, "utf8"));
  return plaintext.toString("utf8");
}

/** Encrypt a token for write-back, generating a fresh per-row DEK. */
export function encryptToken(plaintext: string, aad: string): EncryptedField {
  const dek = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(NONCE_LEN);
  const ct = gcmEncrypt(dek, nonce, Buffer.from(plaintext, "utf8"), Buffer.from(aad, "utf8"));
  const dekCt = wrapDek(dek);
  return { ct, nonce, dekCt };
}
