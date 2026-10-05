import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  randomToken,
  safeEqual,
  sha256Hex,
} from "../src/core/crypto.js";
import { LruCache } from "../src/core/lru.js";

const VALID_KEY = Buffer.alloc(32, 0x42).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 0x99).toString("base64");

describe("core/crypto", () => {
  it("should encrypt and decrypt secrets cleanly", () => {
    const plain = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
    const enc = encryptSecret(plain, VALID_KEY);

    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc).not.toContain(plain);

    const decrypted = decryptSecret(enc, VALID_KEY);
    expect(decrypted).toBe(plain);
  });

  it("should fail decryption when using wrong key", () => {
    const enc = encryptSecret("secret-value", VALID_KEY);
    expect(() => decryptSecret(enc, OTHER_KEY)).toThrow();
  });

  it("should fail decryption if payload is tampered", () => {
    const enc = encryptSecret("secret-value", VALID_KEY);
    const parts = enc.split(":");
    // Tamper with ciphertext
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:AAAA`;
    expect(() => decryptSecret(tampered, VALID_KEY)).toThrow();
  });

  it("should reject keys of invalid length", () => {
    const shortKey = Buffer.alloc(16).toString("base64");
    expect(() => encryptSecret("hello", shortKey)).toThrow(
      "Encryption key must be exactly 32 bytes",
    );
  });

  it("should compute predictable sha256Hex", () => {
    const hash = sha256Hex("test-token");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("test-token")).toBe(hash);
  });

  it("should perform timing-safe string equality", () => {
    expect(safeEqual("abcdef", "abcdef")).toBe(true);
    expect(safeEqual("abcdef", "abcdeg")).toBe(false);
    expect(safeEqual("abcdef", "abc")).toBe(false);
  });

  it("should generate random url-safe tokens", () => {
    const t1 = randomToken(16);
    const t2 = randomToken(16);
    expect(t1).not.toBe(t2);
    expect(t1.length).toBeGreaterThanOrEqual(16);
  });
});

describe("core/lru", () => {
  it("should enforce capacity and evict oldest items", () => {
    const cache = new LruCache<string, number>(3);

    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.size).toBe(3);

    cache.set("d", 4);
    expect(cache.size).toBe(3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  it("should refresh recency on get", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);

    // Reading 'a' makes 'b' the oldest
    expect(cache.get("a")).toBe(1);

    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  it("should support delete", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("x", 10);
    expect(cache.delete("x")).toBe(true);
    expect(cache.get("x")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("should reject non-positive capacity", () => {
    expect(() => new LruCache(0)).toThrow();
    expect(() => new LruCache(-5)).toThrow();
  });
});
