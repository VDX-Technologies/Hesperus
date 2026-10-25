/**
 * Signs firmware releases offline. Keep the private key off the server (a password manager or an
 * offline machine): whoever holds it can install firmware on every node.
 *   npx tsx scripts/sign-firmware.ts keygen <key.pem>
 *     writes a new private key and prints the public key, for FIRMWARE_PUBLIC_KEY and the node
 *   npx tsx scripts/sign-firmware.ts sign <key.pem> <version> <firmware.bin>
 *     prints the signature to paste in /admin/firmware with the same version and file
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { signedMessage, validVersion } from "../lib/engine/firmware";

function publicKeyOf(pem: string) {
  const jwk = createPublicKey(createPrivateKey(pem)).export({ format: "jwk" });
  return Buffer.from(jwk.x!, "base64url");
}

function main([command, ...args]: string[]) {
  if (command === "keygen" && args.length === 1) {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    writeFileSync(args[0], pem, { mode: 0o600, flag: "wx" });
    const raw = publicKeyOf(pem);
    console.log(`private key: ${args[0]}`);
    console.log(`FIRMWARE_PUBLIC_KEY=${raw.toString("base64")}`);
    console.log(`node: static const uint8_t FW_PUBLIC_KEY[32] = {${[...raw].map((b) => `0x${b.toString(16).padStart(2, "0")}`).join(", ")}};`);
    return;
  }
  if (command === "sign" && args.length === 3) {
    const [keyFile, version, binFile] = args;
    if (!validVersion(version)) throw new Error("version must look like 1.2.0");
    const sha256 = createHash("sha256").update(readFileSync(binFile)).digest("hex");
    const signature = sign(null, Buffer.from(signedMessage(version, sha256)), createPrivateKey(readFileSync(keyFile)));
    console.log(`version   ${version}`);
    console.log(`sha256    ${sha256}`);
    console.log(`signature ${signature.toString("base64")}`);
    return;
  }
  console.error("usage: sign-firmware.ts keygen <key.pem> | sign <key.pem> <version> <firmware.bin>");
  process.exit(2);
}

main(process.argv.slice(2));
