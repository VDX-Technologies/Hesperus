import Link from "next/link";
import { tenantDb } from "@/lib/engine/db";
import { listEntries } from "@/lib/packages/records/console";
import { records } from "@/lib/packages/records/model";
import type { Locale } from "@/lib/packages/types";
import type { Dict } from "@/lib/i18n";
import { SectionTitle } from "@/components/ui";
import { EntryList } from "./entries";

/** Records widget on the organization overview: the latest register entries. */
export async function RecordsOverview({ orgId, slug, t, locale }: { orgId: string; slug: string; t: Dict; locale: Locale }) {
  const entries = await listEntries(tenantDb(orgId), { limit: 10 });
  return (
    <section>
      <SectionTitle right={<Link href={`/o/${slug}/upload`} className="text-xs text-mist hover:text-frost">{t.upload} →</Link>}>
        {records.name} · {records.tagline[locale]}
      </SectionTitle>
      <EntryList entries={entries} slug={slug} t={t} locale={locale} />
    </section>
  );
}
