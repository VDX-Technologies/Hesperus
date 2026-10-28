const SIGNATURES: [type: string, magic: number[], offset?: number][] = [
  ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
  ["application/pdf", [0x25, 0x50, 0x44, 0x46, 0x2d]],
  ["application/gzip", [0x1f, 0x8b]],
  ["application/zip", [0x50, 0x4b, 0x03, 0x04]],
];

const WEBP = [0x57, 0x45, 0x42, 0x50];
const ZIPPED = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const TEXT = new Set(["text/csv", "text/plain", "text/tab-separated-values", "application/json"]);

const startsWith = (bytes: Uint8Array, magic: number[], offset = 0) =>
  bytes.length >= offset + magic.length && magic.every((b, i) => bytes[offset + i] === b);

export function sniffType(bytes: Uint8Array, claimed?: string | null): string {
  const said = (claimed ?? "").toLowerCase().split(";")[0].trim();
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, WEBP, 8)) return "image/webp";
  for (const [type, magic, offset] of SIGNATURES) {
    if (!startsWith(bytes, magic, offset)) continue;
    return type === "application/zip" && ZIPPED.has(said) ? said : type;
  }
  if (TEXT.has(said) && !bytes.subarray(0, 8192).includes(0)) return said;
  return "application/octet-stream";
}
