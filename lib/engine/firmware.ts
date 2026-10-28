import { createHash, createPublicKey, verify } from "node:crypto";
import type { Db } from "./db";
import type { ObjectStore } from "./store";

export const FIRMWARE_MAX_BYTES = 0x330000;
export const FIRMWARE_MODULE = "lora";

export type FirmwareRelease = {
  version: string;
  md5: string;
  sha256: string | null;
  signature: string | null;
  size: number;
  storage_key: string;
  notes: string | null;
  current: boolean;
  created_at: Date;
};

export class FirmwareError extends Error {}

export function checkImage(bytes: Uint8Array): string | null {
  if (bytes.length < 256) return "file too small";
  if (bytes.length > FIRMWARE_MAX_BYTES) return `file larger than the OTA slot (${FIRMWARE_MAX_BYTES} bytes)`;
  if (bytes[0] !== 0xe9) return "not an ESP32 firmware image (.pio/build/heltec_v3/firmware.bin)";
  return null;
}

export const validVersion = (v: string) => /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v);

export const signedMessage = (version: string, sha256: string) => `vdx-firmware-v1\n${version}\n${sha256}`;

export function verifySignature(version: string, sha256: string, signature: string, publicKey: string): boolean {
  const raw = Buffer.from(publicKey, "base64");
  const sig = Buffer.from(signature, "base64");
  if (raw.length !== 32 || sig.length !== 64) return false;
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
  return verify(null, Buffer.from(signedMessage(version, sha256)), key, sig);
}

const COLUMNS = "version, md5, sha256, signature, size, storage_key, notes, current, created_at";

export async function listReleases(db: Db): Promise<FirmwareRelease[]> {
  const { rows } = await db.query<FirmwareRelease>(
    `select ${COLUMNS} from firmware_releases
      order by string_to_array(version, '.')::int[] desc`,
  );
  return rows;
}

export async function currentRelease(db: Db): Promise<FirmwareRelease | null> {
  const { rows } = await db.query<FirmwareRelease>(
    `select ${COLUMNS} from firmware_releases where current`,
  );
  return rows[0] ?? null;
}

export async function getRelease(db: Db, version: string): Promise<FirmwareRelease | null> {
  if (!validVersion(version)) return null;
  const { rows } = await db.query<FirmwareRelease>(
    `select ${COLUMNS} from firmware_releases where version = $1`,
    [version],
  );
  return rows[0] ?? null;
}

export async function addRelease(
  db: Db,
  store: ObjectStore,
  input: { version: string; bytes: Uint8Array; signature?: string; notes?: string; current: boolean; userId: string | null },
  publicKey = process.env.FIRMWARE_PUBLIC_KEY || null,
): Promise<FirmwareRelease> {
  if (!validVersion(input.version)) throw new FirmwareError("version must look like 1.2.0");
  const bad = checkImage(input.bytes);
  if (bad) throw new FirmwareError(bad);
  if (await getRelease(db, input.version)) throw new FirmwareError(`version ${input.version} already exists`);
  const md5 = createHash("md5").update(input.bytes).digest("hex");
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const signature = input.signature?.trim() || null;
  if (signature && !publicKey) throw new FirmwareError("FIRMWARE_PUBLIC_KEY is not set: cannot check the signature");
  if (publicKey && !signature) throw new FirmwareError("signature required (scripts/sign-firmware.ts)");
  if (signature && !verifySignature(input.version, sha256, signature, publicKey!))
    throw new FirmwareError("invalid signature for this file and version");
  const key = `firmware/heltec/${input.version}-${md5}.bin`;
  await store.putNew(key, input.bytes, "application/octet-stream");
  if (input.current) await db.query(`update firmware_releases set current = false where current`);
  const { rows } = await db.query<FirmwareRelease>(
    `insert into firmware_releases (version, md5, sha256, signature, size, storage_key, notes, current, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning ${COLUMNS}`,
    [input.version, md5, sha256, signature, input.bytes.length, key, input.notes?.trim() || null, input.current, input.userId],
  );
  return rows[0];
}

export async function setCurrent(db: Db, version: string | null): Promise<void> {
  await db.query(`update firmware_releases set current = false where current and version is distinct from $1`, [version]);
  if (version) await db.query(`update firmware_releases set current = true where version = $1`, [version]);
}

export async function deleteRelease(db: Db, version: string): Promise<void> {
  await db.query(`delete from firmware_releases where version = $1`, [version]);
}
