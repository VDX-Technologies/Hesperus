import Link from "next/link";
import type { RecordEntry } from "@/lib/packages/records/console";
import { RECORD_FIELDS } from "@/lib/packages/records/model";
import type { Locale } from "@/lib/packages/types";
import type { Dict } from "@/lib/i18n";

const COLS = RECORD_FIELDS.filter((f) => f !== "date" && f !== "subject");

export function EntryList({ entries, slug, t, locale, showSubject = true }: {
  entries: RecordEntry[]; slug: string; t: Dict; locale: Locale; showSubject?: boolean;
}) {
  if (!entries.length) return <p className="text-sm text-dim">{t.recordsNone}</p>;
  const cols = COLS.filter((c) => entries.some((e) => e.payload[c] !== undefined));
  const date = (iso: string) => new Date(iso).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" });
  const cell = (v: unknown) => (typeof v === "number" ? v.toLocaleString(locale) : v === undefined ? "—" : String(v));
  const subject = (e: RecordEntry) =>
    <Link href={`/terra/o/${slug}/devices/${e.objectId}`} className="hover:text-frost">{e.subject}</Link>;
  return (
    <>
      <div className="card hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-dim">
            <tr>
              <th className="px-4 py-2 font-normal">{t.rec_date}</th>
              {showSubject && <th className="px-4 py-2 font-normal">{t.rec_subject}</th>}
              {cols.map((c) => <th key={c} className="px-4 py-2 font-normal">{t[`rec_${c}`]}</th>)}
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-t border-line/60">
                <td className="num px-4 py-2 whitespace-nowrap">{date(e.ts)}</td>
                {showSubject && <td className="px-4 py-2">{subject(e)}</td>}
                {cols.map((c) => <td key={c} className="num px-4 py-2 text-mist">{cell(e.payload[c])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-2 md:hidden">
        {entries.map((e) => (
          <div key={e.id} className="card p-4 text-sm">
            <div className="flex justify-between gap-3">
              <span className="font-medium">{showSubject ? subject(e) : cell(e.payload.kind)}</span>
              <span className="num text-dim">{date(e.ts)}</span>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              {cols.filter((c) => e.payload[c] !== undefined).map((c) => (
                <div key={c}><dt className="inline text-dim">{t[`rec_${c}`]}: </dt><dd className="num inline text-mist">{cell(e.payload[c])}</dd></div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </>
  );
}
