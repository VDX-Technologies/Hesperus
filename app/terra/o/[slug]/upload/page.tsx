import { agronomyPackage } from "@/lib/packages/agronomy";
import { requireConsole } from "@/lib/auth";
import { getT, timeAgo, type Dict } from "@/lib/i18n";
import { tenantDb } from "@/lib/engine/db";
import { listUploads, uploadSources } from "@/lib/engine/upload";
import { RECORD_FIELDS, REQUIRED_FIELDS } from "@/lib/packages/records/model";
import { SectionTitle } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { countLegacyEntries } from "@/lib/packages/agronomy/import";
import { deleteDocument, moveLegacy, reprocessDocument } from "./actions";
import { UploadForm } from "./form";

const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

export default async function Upload(props: PageProps<"/terra/o/[slug]/upload">) {
  const { slug } = await props.params;
  const { org, role } = await requireConsole(slug, "terra");
  const { t, locale } = await getT();
  const db = tenantDb(org.id);
  const sp = await props.searchParams;
  const [sources, uploads, legacy] = await Promise.all([uploadSources(db), listUploads(db, 200), countLegacyEntries(db, org.id)]);
  const owner = role === "owner";
  const done = typeof sp.done === "string" && `doc_${sp.done}` in t ? t[`doc_${sp.done}` as keyof Dict] : null;
  const error = typeof sp.error === "string" && sp.error in t ? t[sp.error as keyof Dict] : null;
  const registerName = (k: string | null) =>
    (k && (agronomyPackage.eventTypes ?? []).find((e) => e.key === k)?.name[locale]) || t.docNoRegister;
  const btn = "rounded-md border border-line px-2.5 py-1 text-xs text-mist hover:border-ice/60 hover:text-frost";
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
          sources={sources.filter((s) => s.status !== "paused").map((s) => ({ id: s.id, name: s.name, }))}
          fields={RECORD_FIELDS.map((f) => ({ key: f, label: t[`rec_${f}` as keyof Dict], required: REQUIRED_FIELDS.includes(f) }))}
          labels={{
            uploadSource: t.uploadSource,
            uploadPick: t.uploadPick,
            uploadDrop: t.uploadDrop,
            uploadMappingHelp: t.uploadMappingHelp,
            uploadIgnore: t.uploadIgnore,
            uploadSend: t.uploadSend,
            uploadSending: t.uploadSending,
            uploadDone: t.uploadDone,
            uploadStored: t.uploadStored,
            uploadReading: t.uploadReading,
            uploadFound: t.uploadFound,
            uploadNoTable: t.uploadNoTable,
            uploadRejectedRows: t.uploadRejectedRows,
            uploadLine: t.uploadLine,
            uploadSendReady: t.uploadSendReady,
            uploadReady: t.uploadReady,
            uploadReview: t.uploadReview,
            uploadKnown: t.uploadKnown,
            uploadMissing: t.uploadMissing,
            uploadRemove: t.uploadRemove,
            uploadClear: t.uploadClear,
            uploadSure: t.uploadSure,
            uploadUnsure: t.uploadUnsure,
            errors,
            registers: Object.fromEntries((agronomyPackage.eventTypes ?? []).map((e) => [e.key, `${t.uploadInto} ${e.name[locale] ?? e.name.en}`])),
          }}
        />
      )}

      {done && <p className="mb-4 mt-6 rounded-lg border border-ok/40 bg-ok/10 px-4 py-2.5 text-sm">{done} <span className="num">{String(sp.n ?? "")}</span></p>}
      {error && <p className="mb-4 mt-6 rounded-lg border border-alarm/40 bg-alarm/10 px-4 py-2.5 text-sm">{error}</p>}

      {owner && legacy > 0 && (
        <div className="card mt-6 flex flex-wrap items-center justify-between gap-4 border-warn/40 p-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-warn">{t.legacyTitle} · <span className="num">{legacy}</span></div>
            <p className="mt-1 max-w-2xl text-xs text-mist">{t.legacyHelp}</p>
          </div>
          <form action={moveLegacy}>
            <input type="hidden" name="slug" value={slug} />
            <ConfirmButton message={t.legacyConfirm} className="rounded-md bg-warn px-3 py-1.5 text-xs font-semibold text-ink-950 hover:opacity-90">
              {t.legacyMove}
            </ConfirmButton>
          </form>
        </div>
      )}

      <SectionTitle right={<span className="num text-xs text-dim">{uploads.length} {t.docFiles}</span>}>{t.uploadRecent}</SectionTitle>
      {!uploads.length ? (
        <div className="card p-5 text-sm text-mist">{t.uploadNone}</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b border-line text-left text-[11px] uppercase tracking-wider text-dim">
              <tr>
                <th className="px-4 py-2.5 font-medium">{t.uploadRecent}</th>
                <th className="px-3 py-2.5 font-medium">{t.uploadSource}</th>
                <th className="px-3 py-2.5 text-right font-medium">{t.docRows}</th>
                <th className="px-3 py-2.5 text-right font-medium">{t.docEntries}</th>
                <th className="px-3 py-2.5 text-right font-medium">{t.docRejected}</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {uploads.map((u) => (
                <tr key={u.id} className="hover:bg-ink-800/60">
                  <td className="max-w-xs px-4 py-2.5">
                    <div className="truncate font-medium text-frost">{u.filename ?? "–"}</div>
                    <div className="text-xs text-dim">{u.source ?? "–"} · {fmtSize(u.size)} · {timeAgo(u.createdAt.toISOString(), locale, t)}</div>
                  </td>
                  <td className="px-3 py-2.5 text-xs">
                    <span className={`rounded border px-1.5 py-0.5 ${u.register ? "border-ice/40 text-ice" : "border-line text-dim"}`}>
                      {u.table ? registerName(u.register) : t.uploadStored}
                    </span>
                  </td>
                  <td className="num px-3 py-2.5 text-right text-mist">{u.table ? u.rows : "–"}</td>
                  <td className="num px-3 py-2.5 text-right text-ok">{u.events}</td>
                  <td className="num px-3 py-2.5 text-right">
                    {u.rejectedCount > 0 ? (
                      <span className="text-warn" title={u.rejected.slice(0, 10).map((r) => `${t.uploadLine} ${r.line}: ${r.error}`).join("\n")}>{u.rejectedCount}</span>
                    ) : <span className="text-dim">0</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-1.5">
                      <a href={`/terra/o/${slug}/upload/${u.id}`} className={btn}>{t.docDownload}</a>
                      {owner && (
                        <>
                          <form action={reprocessDocument}>
                            <input type="hidden" name="slug" value={slug} />
                            <input type="hidden" name="id" value={u.id} />
                            <ConfirmButton message={t.docReprocessConfirm} className={btn}>{t.docReprocess}</ConfirmButton>
                          </form>
                          <form action={deleteDocument}>
                            <input type="hidden" name="slug" value={slug} />
                            <input type="hidden" name="id" value={u.id} />
                            <ConfirmButton message={t.docDeleteConfirm} className="rounded-md border border-alarm/40 px-2.5 py-1 text-xs text-alarm hover:bg-alarm/10">
                              {t.docDelete}
                            </ConfirmButton>
                          </form>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
