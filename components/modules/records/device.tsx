import { tenantDb } from "@/lib/engine/db";
import type { ConsoleObject } from "@/lib/packages/console";
import { listEntries } from "@/lib/packages/records/console";
import type { Locale } from "@/lib/packages/types";
import type { Dict } from "@/lib/i18n";
import { SectionTitle } from "@/components/ui";
import { EntryList } from "./entries";

/** Records object page: every entry of one subject. */
export async function RecordsDevice({ orgId, device, baseHref, t, locale }: {
  orgId: string; device: ConsoleObject; range: "24h" | "7d"; baseHref: string; t: Dict; locale: Locale;
}) {
  const entries = await listEntries(tenantDb(orgId), { objectId: device.id, limit: 200 });
  const slug = baseHref.split("/")[2];
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{device.name}</h1>
      <SectionTitle>{t.recordsLatest}</SectionTitle>
      <EntryList entries={entries} slug={slug} t={t} locale={locale} showSubject={false} />
    </div>
  );
}
