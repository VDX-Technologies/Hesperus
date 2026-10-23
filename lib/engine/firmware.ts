// Firmware releases for the Heltec nodes. The admin uploads a .bin from /admin/firmware; the nodes
// read /api/firmware/manifest with their source token and flash the current release when it is
// newer than theirs (the node checks the MD5 before switching OTA slot).
import { createHash } from "node:crypto";
import type { Db } from "./db";
import type { ObjectStore } from "./store";

/** One OTA slot of the default_8MB.csv partition table (0x330000). */
export const FIRMWARE_MAX_BYTES = 0x330000;
/** Module whose push sources are Heltec nodes. */
export const FIRMWARE_MODULE = "lora";

export type FirmwareRelease = {
  version: string;
  md5: string;
  size: number;
  storage_key: string;
  notes: string | null;
  current: boolean;
  created_at: Date;
};

export class FirmwareError extends Error {}

/** Returns why the bytes are not an ESP32 application image, or null. */
export function checkImage(bytes: Uint8Array): string | null {
  if (bytes.length < 256) return "file too small";
  if (bytes.length > FIRMWARE_MAX_BYTES) return `file larger than the OTA slot (${FIRMWARE_MAX_BYTES} bytes)`;
  if (bytes[0] !== 0xe9) return "not an ESP32 firmware image (.pio/build/heltec_v3/firmware.bin)";
  return null;
}

export const validVersion = (v: string) => /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v);

export async function listReleases(db: Db): Promise<FirmwareRelease[]> {
  const { rows } = await db.query<FirmwareRelease>(
    `select version, md5, size, storage_key, notes, current, created_at from firmware_releases
      order by string_to_array(version, '.')::int[] desc`,
  );
  return rows;
}

export async function currentRelease(db: Db): Promise<FirmwareRelease | null> {
  const { rows } = await db.query<FirmwareRelease>(
    `select version, md5, size, storage_key, notes, current, created_at from firmware_releases where current`,
  );
  return rows[0] ?? null;
}

export async function getRelease(db: Db, version: string): Promise<FirmwareRelease | null> {
  if (!validVersion(version)) return null;
  const { rows } = await db.query<FirmwareRelease>(
    `select version, md5, size, storage_key, notes, current, created_at from firmware_releases where version = $1`,
    [version],
  );
  return rows[0] ?? null;
}

/** Stores the binary and adds the release; current=true makes it the one the nodes install. */
export async function addRelease(
  db: Db,
  store: ObjectStore,
  input: { version: string; bytes: Uint8Array; notes?: string; current: boolean; userId: string | null },
): Promise<FirmwareRelease> {
  if (!validVersion(input.version)) throw new FirmwareError("version must look like 1.2.0");
  const bad = checkImage(input.bytes);
  if (bad) throw new FirmwareError(bad);
  if (await getRelease(db, input.version)) throw new FirmwareError(`version ${input.version} already exists`);
  const md5 = createHash("md5").update(input.bytes).digest("hex");
  // The store never overwrites: the md5 in the key lets a deleted version be uploaded again.
  const key = `firmware/heltec/${input.version}-${md5}.bin`;
  await store.putNew(key, input.bytes, "application/octet-stream");
  if (input.current) await db.query(`update firmware_releases set current = false where current`);
  const { rows } = await db.query<FirmwareRelease>(
    `insert into firmware_releases (version, md5, size, storage_key, notes, current, created_by)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning version, md5, size, storage_key, notes, current, created_at`,
    [input.version, md5, input.bytes.length, key, input.notes?.trim() || null, input.current, input.userId],
  );
  return rows[0];
}

/** Makes one release current (null = none: the nodes stop updating). */
export async function setCurrent(db: Db, version: string | null): Promise<void> {
  await db.query(`update firmware_releases set current = false where current and version is distinct from $1`, [version]);
  if (version) await db.query(`update firmware_releases set current = true where version = $1`, [version]);
}

/** Removes the release from the list; the binary stays in the store (it never deletes). */
export async function deleteRelease(db: Db, version: string): Promise<void> {
  await db.query(`delete from firmware_releases where version = $1`, [version]);
}
