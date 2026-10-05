import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const VERSION = "v1";

function decodeKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) {
    throw new Error("Encryption key must be exactly 32 bytes (base64-encoded)");
  }
  return key;
}

/**
 * Encrypts a secret (bot token) with AES-256-GCM.
 * Output format: `v1:<iv>:<authTag>:<ciphertext>` (all base64).
 */
export function encryptSecret(plain: string, keyBase64: string): string {
  const key = decodeKey(keyBase64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

/** Decrypts a value produced by `encryptSecret`. Throws on tampering or wrong key. */
export function decryptSecret(payload: string, keyBase64: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Unsupported encrypted payload format");
  }
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const key = decodeKey(keyBase64);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]);
  return plain.toString("utf8");
}

/** SHA-256 hex digest — used as the public webhook path segment instead of the token. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time string comparison (prevents timing attacks on secrets). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Random URL-safe token. Telegram's secret_token allows only [A-Za-z0-9_-], 1..256 chars,
 * which base64url satisfies.
 */
export function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}
