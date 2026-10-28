import type { Db } from "@/lib/engine/db";
import { FIRMWARE_MODULE } from "@/lib/engine/firmware";
import { authSource } from "@/lib/engine/source-auth";

export async function nodeSource(request: Request): Promise<{ db: Db } | { error: Response }> {
  const auth = await authSource(request, "write", (s) =>
    s.connector === "push" && s.module === FIRMWARE_MODULE ? null : "no firmware for this source");
  return "error" in auth ? auth : { db: auth.db };
}
