import Link from "next/link";
import { tenantDb } from "@/lib/engine/db";
import { ANALYSIS_ENTRY_LIMIT, loadEntries } from "@/lib/packages/records/console";
import { analyze } from "@/lib/packages/records/analysis";
import { records } from "@/lib/packages/records/model";
import type { Locale } from "@/lib/packages/types";
import type { Dict } from "@/lib/i18n";
import { SectionTitle } from "@/components/ui";
import { EntryList } from "./entries";
import { Doses, Heatmap, Kpis, Shares, Signals, Weeks } from "./analysis";

/** Records on the organization overview: totals, the work week by week, signals, then the latest entries. */
export async function RecordsOverview({ orgId, slug, t, locale }: { orgId: string; slug: string; t: Dict; locale: Locale; period?: number }) {
  const entries = await loadEntries(tenantDb(orgId));
  // files about agronomy work go to their own registers: nothing left here, nothing to show
  if (!entries.length) return null;
  const partial = entries.length > ANALYSIS_ENTRY_LIMIT;
  const a = analyze(partial ? entries.slice(0, ANALYSIS_ENTRY_LIMIT) : entries, new Date(), 5, partial);
  return (
    <section className="space-y-4">
      <SectionTitle right={<Link href={`/o/${slug}/upload`} className="text-xs text-mist hover:text-frost">{t.upload} →</Link>}>
        {records.name} · {records.tagline[locale]}
      </SectionTitle>
      {entries.length > 0 && (
        <>
          {a.partial && <p role="note" className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">{t.an_partial}</p>}
          <Kpis a={a} t={t} locale={locale} />
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <div className="mb-2 text-xs uppercase tracking-wider text-dim">{t.an_weeks}</div>
              <Weeks a={a} t={t} locale={locale} />
            </div>
            <div>
              <div className="mb-2 text-xs uppercase tracking-wider text-dim">{t.an_signals}</div>
              <Signals a={a} slug={slug} t={t} locale={locale} />
            </div>
          </div>
          {a.matrix.length > 1 && a.weeks.length > 1 && (
            <div>
              <div className="mb-2 text-xs uppercase tracking-wider text-dim">{t.an_heat}</div>
              <Heatmap a={a} slug={slug} t={t} locale={locale} />
            </div>
          )}
          {a.doses.length >= 3 && (
            <div>
              <div className="mb-2 text-xs uppercase tracking-wider text-dim">{t.an_doses}</div>
              <Doses a={a} t={t} locale={locale} />
            </div>
          )}
          <Shares a={a} slug={slug} t={t} locale={locale} />
        </>
      )}
      <div className="mb-2 text-xs uppercase tracking-wider text-dim">{t.recordsLatest}</div>
      <EntryList entries={entries.slice(0, 10)} slug={slug} t={t} locale={locale} />
    </section>
  );
}
