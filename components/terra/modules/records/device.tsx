import { tenantDb } from "@/lib/engine/db";
import type { ConsoleObject } from "@/lib/packages/console";
import { ANALYSIS_ENTRY_LIMIT, loadEntries } from "@/lib/packages/records/console";
import { analyze } from "@/lib/packages/records/analysis";
import type { Locale } from "@/lib/packages/types";
import type { Dict } from "@/lib/i18n";
import { SectionTitle } from "@/components/ui";
import { EntryList } from "./entries";
import { Doses, Kpis, Shares, Signals, Weeks } from "./analysis";

export async function RecordsDevice({ orgId, device, baseHref, t, locale }: {
  orgId: string; device: ConsoleObject; range: "24h" | "7d"; baseHref: string; t: Dict; locale: Locale;
}) {
  const entries = await loadEntries(tenantDb(orgId), { objectId: device.id });
  const partial = entries.length > ANALYSIS_ENTRY_LIMIT;
  const a = analyze(partial ? entries.slice(0, ANALYSIS_ENTRY_LIMIT) : entries, new Date(), 5, partial);
  const slug = baseHref.split("/")[2];
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">{device.name}</h1>
      {entries.length > 0 && (
        <>
          {a.partial && <p role="note" className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">{t.an_partial}</p>}
          <Kpis a={a} t={t} locale={locale} />
          <Weeks a={a} t={t} locale={locale} />
          {a.signals.length > 0 && <Signals a={a} slug={slug} t={t} locale={locale} />}
          <Doses a={a} t={t} locale={locale} />
          <Shares a={a} slug={slug} t={t} locale={locale} />
        </>
      )}
      <SectionTitle>{t.recordsLatest}</SectionTitle>
      <EntryList entries={entries.slice(0, 200)} slug={slug} t={t} locale={locale} showSubject={false} />
    </div>
  );
}
