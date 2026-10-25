import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { Client } from "pg";
import { freshDb } from "../db/setup";
import { MemoryStore } from "../../lib/engine/store";
import {
  addRelease, checkImage, currentRelease, FIRMWARE_MAX_BYTES, signedMessage, validVersion, verifySignature,
} from "../../lib/engine/firmware";

const image = (n: number, first = 0xe9) => {
  const b = new Uint8Array(n);
  b[0] = first;
  return b;
};

describe("firmware", () => {
  it("accepts only ESP32 application images that fit one OTA slot", () => {
    expect(checkImage(image(1024))).toBeNull();
    expect(checkImage(image(100))).toMatch(/small/);
    expect(checkImage(image(FIRMWARE_MAX_BYTES + 1))).toMatch(/OTA slot/);
    expect(checkImage(image(1024, 0x50))).toMatch(/ESP32/);
  });

  it("wants versions like the node's FW_VERSION", () => {
    expect(validVersion("1.2.0")).toBe(true);
    expect(validVersion("1.2")).toBe(false);
    expect(validVersion("1.2.0-beta")).toBe(false);
    expect(validVersion("../1.2.0")).toBe(false);
  });
});

describe("signed firmware", () => {
  let db: Client;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await freshDb()));
  afterAll(async () => drop?.());

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url").toString("base64");
  const bin = image(2048);
  bin[100] = 7;
  const sha = createHash("sha256").update(bin).digest("hex");
  const signed = (version: string, hash = sha) => sign(null, Buffer.from(signedMessage(version, hash)), privateKey).toString("base64");
  const add = (version: string, signature: string | undefined, key: string | null = pub, bytes = bin) =>
    addRelease(db, new MemoryStore(), { version, bytes, signature, current: true, userId: null }, key);

  it("verifies the signature over version and sha256", () => {
    expect(verifySignature("1.0.0", sha, signed("1.0.0"), pub)).toBe(true);
    expect(verifySignature("1.0.1", sha, signed("1.0.0"), pub)).toBe(false); // relabelled
    expect(verifySignature("1.0.0", "0".repeat(64), signed("1.0.0"), pub)).toBe(false); // swapped binary
    expect(verifySignature("1.0.0", sha, "AAAA", pub)).toBe(false);
  });

  it("stores sha256 and signature, and refuses unsigned or badly signed releases when a key is set", async () => {
    await expect(add("1.0.0", undefined)).rejects.toThrow(/signature required/);
    await expect(add("1.0.0", signed("2.0.0"))).rejects.toThrow(/invalid signature/);
    const other = image(2048);
    await expect(add("1.0.0", signed("1.0.0"), pub, other)).rejects.toThrow(/invalid signature/);
    await expect(add("1.0.0", signed("1.0.0"), null)).rejects.toThrow(/FIRMWARE_PUBLIC_KEY/);
    const r = await add("1.0.0", signed("1.0.0"));
    expect(r.sha256).toBe(sha);
    expect(r.signature).toBe(signed("1.0.0"));
    expect((await currentRelease(db))?.signature).toBe(r.signature);
  });

  it("still accepts unsigned releases while no key is configured", async () => {
    const r = await add("1.0.1", undefined, null);
    expect(r).toMatchObject({ sha256: sha, signature: null });
  });
});
