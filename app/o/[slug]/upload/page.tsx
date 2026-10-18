import { requireOrg } from "@/lib/auth";
import { getT, timeAgo, type Dict } from "@/lib/i18n";
import { tenantDb } from "@/lib/engine/db";
import { listUploads, uploadConfig, uploadSources } from "@/lib/engine/upload";
import { RECORD_FIELDS, REQUIRED_FIELDS } from "@/lib/packages/records/model";
import { SectionTitle } from "@/components/ui";
import { UploadForm } from "./form";

const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

/** CSV files loaded into the tenant's upload sources, and the form to load a new one (owner only). */
export default async function Upload(props: PageProps<"/o/[slug]/upload">) {
  const { slug } = await props.params;
  const { org, role } = await requireOrg(slug);
  const { t, locale } = await getT();
  const db = tenantDb(org.id);
  const [sources, uploads] = await Promise.all([uploadSources(db), listUploads(db)]);
  const errors = Object.fromEntries(Object.entries(t).filter(([k]) => k.startsWith("uploadErr_") || k === "uploadOnlyOwner"));

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t.upload}</h1>
      <p className="mb-6 mt-1 text-sm text-mist">{t.uploadHelp}</p>
      {!sources.length ? (
        <div className="card p-5 text-sm text-mist">{t.uploadNoSources}</div>
      ) : role !== "owner" ? (
        <div className="card p-5 text-sm text-mist">{t.uploadOnlyOwner}</div>
      ) : (
        <UploadForm
          slug={slug}
          sources={sources.filter((s) => s.status !== "paused").map((s) => ({ id: s.id, name: s.name, mapping: uploadConfig(s).mapping }))}
          fields={RECORD_FIELDS.map((f) => ({ key: f, label: t[`rec_${f}` as keyof Dict], required: REQUIRED_FIELDS.includes(f) }))}
          labels={{
            uploadSource: t.uploadSource,
            uploadFile: t.uploadFile,
            uploadMapping: t.uploadMapping,
            uploadMappingHelp: t.uploadMappingHelp,
            uploadIgnore: t.uploadIgnore,
            uploadSend: t.uploadSend,
            uploadSending: t.uploadSending,
            uploadDone: t.uploadDone,
            uploadRejectedRows: t.uploadRejectedRows,
            uploadLine: t.uploadLine,
            errors,
          }}
        />
      )}

      <SectionTitle>{t.uploadRecent}</SectionTitle>
      {!uploads.length ? (
        <div className="card p-5 text-sm text-mist">{t.uploadNone}</div>
      ) : (
        <ul className="card divide-y divide-line-soft">
          {uploads.map((u) => (
            <li key={u.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
              <div className="min-w-0">
                <div className="truncate font-medium text-ice">{u.filename ?? "–"}</div>
                <div className="text-xs text-dim">
                  {u.source ?? "–"} · {fmtSize(u.size)} · {timeAgo(u.createdAt.toISOString(), locale, t)}
                </div>
              </div>
              <div className="num text-xs">
                <span className="text-ok">
                  {u.accepted} / {u.rows} {t.uploadDone}
                </span>
                {u.rejectedCount > 0 && (
                  <span className="ml-2 text-warn" title={u.rejected.slice(0, 10).map((r) => `${t.uploadLine} ${r.line}: ${r.error}`).join("\n")}>
                    {u.rejectedCount} {t.uploadRejectedRows}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
