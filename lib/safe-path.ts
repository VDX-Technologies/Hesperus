/** A form's "back" target as a local path only: anything else (other hosts, "//x", "/\x") becomes "/". */
export function safePath(v: FormDataEntryValue | null): string {
  const s = typeof v === "string" ? v : "";
  return /^\/(?![/\\])[^\s?#]*$/.test(s) ? s : "/";
}
