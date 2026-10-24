import Link from "next/link";
import { COLUMNS, COLUMN_LABELS, cell, type RegisterRow } from "@/lib/packages/agronomy/register";
import type { Locale } from "@/lib/packages/types";
import type { Dict } from "@/lib/i18n";

/** The register: a table in paper order on wide screens, one card per treatment on a phone. */
export function TreatmentRows({ rows, locale, t, editHref }: { rows: RegisterRow[]; locale: Locale; t: Dict; editHref?: (r: RegisterRow) => string }) {
  if (!rows.length) return <p className="text-sm text-dim">{t.noTreatments}</p>;
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-dim">
              {COLUMNS.map((c) => <th key={c} className="px-2 py-2 font-normal">{COLUMN_LABELS[c][locale]}</th>)}
              {editHref && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line align-top">
                {COLUMNS.map((c) => <td key={c} className={`px-2 py-2 ${c === "areaHa" || c === "quantity" ? "num" : ""}`}>{cell(r, c, locale)}</td>)}
                {editHref && (
                  <td className="px-2 py-2 text-right">
                    <Link href={editHref(r)} className="text-xs text-frost hover:underline">{t.correct}</Link>
                    {r.version > 1 && <div className="text-[11px] text-dim">{t.version} {r.version}</div>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden">
        {rows.map((r) => (
          <li key={r.id} className="card p-3 text-sm">
            <div className="flex justify-between gap-2">
              <span className="font-medium">{cell(r, "crop", locale)}</span>
              <span className="num text-dim">{cell(r, "date", locale)}</span>
            </div>
            <div className="mt-1">{cell(r, "product", locale)} · <span className="num">{cell(r, "quantity", locale)}</span></div>
            <div className="text-mist">{cell(r, "adversity", locale)} · {cell(r, "phase", locale)} · <span className="num">{cell(r, "areaHa", locale)}</span> ha</div>
            {cell(r, "notes", locale) && <div className="mt-1 text-xs text-dim">{cell(r, "notes", locale)}</div>}
            {editHref && (
              <div className="mt-2 flex justify-between text-xs">
                <span className="text-dim">{r.version > 1 ? `${t.version} ${r.version}` : ""}</span>
                <Link href={editHref(r)} className="text-frost">{t.correct}</Link>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
