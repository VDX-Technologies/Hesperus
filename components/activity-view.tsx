import Link from "next/link";
import { getT } from "@/lib/i18n";
import type { TenantDb } from "@/lib/engine/db";
import { listAudit } from "@/lib/engine/audit";
import { ActivityList } from "@/components/activity-list";

const PAGE = 100;

export async function ActivityView({ db, before, href }: { db: TenantDb; before?: string | string[]; href: string }) {
  const { t, locale } = await getT();
  const entries = await listAudit(db, { limit: PAGE, before: Number(before) || undefined });
  const ids = [...new Set(entries.map((e) => e.objectId).filter((x): x is string => !!x))];
  const { rows } = ids.length
    ? await db.query<{ id: string; name: string }>(`select id, coalesce(name, external_id, '') as name from objects where tenant_id = $1 and id = any($2)`, [db.tenantId, ids])
    : { rows: [] };
  const names = Object.fromEntries(rows.map((r) => [r.id, r.name]));
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t.activity}</h1>
      <p className="mb-6 mt-1 text-sm text-mist">{t.activityHelp}</p>
      <ActivityList entries={entries} t={t} locale={locale} names={names} />
      {entries.length === PAGE && (
        <Link href={`${href}?before=${entries[entries.length - 1].id}`} className="btn mt-4 inline-block text-sm">
          {t.older}
        </Link>
      )}
    </div>
  );
}
