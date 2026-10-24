import Link from "next/link";
import { requireOrg } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { tenantDb } from "@/lib/engine/db";
import { listAudit } from "@/lib/engine/audit";
import { ActivityList } from "@/components/activity-list";

const PAGE = 100;

export default async function Activity(props: PageProps<"/terra/o/[slug]/activity">) {
  const { slug } = await props.params;
  const { before } = await props.searchParams;
  const { org } = await requireOrg(slug);
  const { t, locale } = await getT();
  const db = tenantDb(org.id);
  const entries = await listAudit(db, { limit: PAGE, before: Number(before) || undefined });
  // current names of the objects the rows point at (deleted ones simply have none)
  const ids = [...new Set(entries.map((e) => e.objectId).filter((x): x is string => !!x))];
  const { rows } = ids.length
    ? await db.query<{ id: string; name: string }>(`select id, coalesce(name, external_id, '') as name from objects where tenant_id = $1 and id = any($2)`, [org.id, ids])
    : { rows: [] };
  const names = Object.fromEntries(rows.map((r) => [r.id, r.name]));
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t.activity}</h1>
      <p className="mb-6 mt-1 text-sm text-mist">{t.activityHelp}</p>
      <ActivityList entries={entries} t={t} locale={locale} names={names} />
      {entries.length === PAGE && (
        <Link href={`/terra/o/${slug}/activity?before=${entries[entries.length - 1].id}`} className="btn mt-4 inline-block text-sm">
          {t.older}
        </Link>
      )}
    </div>
  );
}
