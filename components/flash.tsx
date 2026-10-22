import type { Dict } from "@/lib/i18n";

/** Result message after a settings form (from ?saved=1, ?saved=<key> for t.saved_<key>, or ?error=<key>). */
export function Flash({ saved, error, t }: { saved?: string | string[]; error?: string | string[]; t: Dict }) {
  if (error && typeof error === "string" && error in t)
    return <p className="mb-4 rounded-lg border border-alarm/40 bg-alarm/10 px-4 py-2.5 text-sm">{t[error as keyof Dict]}</p>;
  if (saved) {
    const own = typeof saved === "string" && `saved_${saved}` in t ? t[`saved_${saved}` as keyof Dict] : t.saved;
    return <p className="mb-4 rounded-lg border border-ok/40 bg-ok/10 px-4 py-2.5 text-sm">{own}</p>;
  }
  return null;
}
