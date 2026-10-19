import { tenantDb } from "@/lib/engine/db";
import type { ConsoleObject } from "@/lib/packages/console";
import { loadEntries } from "@/lib/packages/records/console";
import { analyze } from "@/lib/packages/records/analysis";
import type { Locale } from "@/lib/packages/types";
import type { Dict } from "@/lib/i18n";
import { SectionTitle } from "@/components/ui";
import { EntryList } from "./entries";
import { Doses, Kpis, Shares, Signals, Weeks } from "./analysis";

/** Records object page: what the subject's entries add up to, its signals and every entry. */
export async function RecordsDevice({ orgId, device, baseHref, t, locale }: {
  orgId: string; device: ConsoleObject; range: "24h" | "7d"; baseHref: string; t: Dict; locale: Locale;
}) {
  const entries = await loadEntries(tenantDb(orgId), { objectId: device.id });
  const a = analyze(entries);
  const slug = baseHref.split("/")[2];
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">{device.name}</h1>
      {entries.length > 0 && (
        <>
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
