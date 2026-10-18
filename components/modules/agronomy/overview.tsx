import Link from "next/link";
import { tenantDb } from "@/lib/engine/db";
import { listCrops, listTreatments } from "@/lib/packages/agronomy/console";
import type { Locale } from "@/lib/packages/types";
import type { Dict } from "@/lib/i18n";
import { SectionTitle } from "@/components/ui";
import { TreatmentRows } from "./rows";

/** Agronomy widget on the organization overview: crops count and the latest treatments. */
export async function AgronomyOverview({ orgId, slug, t, locale }: { orgId: string; slug: string; t: Dict; locale: Locale }) {
  const db = tenantDb(orgId);
  const crops = await listCrops(db);
  const rows = await listTreatments(db, {}, crops, 5);
  return (
    <section>
      <SectionTitle right={<Link href={`/o/${slug}/treatments`} className="text-xs text-frost hover:underline">{t.treatmentsRegister} →</Link>}>
        {t.treatments} <span className="num text-dim">· {crops.length} {t.crops.toLowerCase()}</span>
      </SectionTitle>
      {crops.length ? <TreatmentRows rows={rows} locale={locale} t={t} /> : <p className="text-sm text-dim">{t.noCrops}</p>}
    </section>
  );
}
