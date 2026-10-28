export function safePath(v: FormDataEntryValue | null): string {
  const s = typeof v === "string" ? v : "";
  return /^\/(?![/\\])[^\s?#]*$/.test(s) ? s : "/";
}
