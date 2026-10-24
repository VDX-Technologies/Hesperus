// A result's attachments as the console shows them: raster images previewed, CSV files as the
// table of their first rows, PDFs opened in the browser's viewer, anything else downloaded.
import type { Dict } from "@/lib/i18n";
import type { Locale } from "@/lib/packages/types";
import type { TenantDb } from "@/lib/engine/db";
import type { ObjectDocument } from "@/lib/engine/custom-objects";
import { csvPreview, inlineImage, isCsv, isPdf } from "@/lib/research";
import { readDocument } from "./documents";

// bigger files are only offered for download: the preview reads the whole file from the store
const PREVIEW_BYTES = 5 * 1024 * 1024;

export async function Attachments({ db, slug, docs, t, locale }: { db: TenantDb; slug: string; docs: ObjectDocument[]; t: Dict; locale: Locale }) {
  const doc = (d: { id: string }) => `/research/o/${slug}/doc/${d.id}`;
  const images = docs.filter((d) => inlineImage(d.contentType));
  const tables = await Promise.all(
    docs
      .filter((d) => isCsv(d.contentType, d.filename) && (d.size ?? 0) <= PREVIEW_BYTES)
      .slice(0, 5)
      .map(async (d) => {
        const bytes = (await readDocument(db, d.id))?.bytes;
        return { d, preview: bytes ? csvPreview(bytes) : null };
      }),
  );
  const previewed = new Set([...images.map((d) => d.id), ...tables.filter((x) => x.preview).map((x) => x.d.id)]);
  const files = docs.filter((d) => !inlineImage(d.contentType));
  const size = (d: ObjectDocument) => (d.size ?? 0) < 1024 * 1024 ? `${Math.ceil((d.size ?? 0) / 1024)} KB` : `${((d.size ?? 0) / 1024 / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })} MB`;
  if (!docs.length) return <p className="mt-3 text-sm text-dim">{t.noAttachments}</p>;
  return (
    <>
      {images.length > 0 && (
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {images.map((d) => (
            <figure key={d.id} className="card p-2">
              <a href={doc(d)} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element -- private, tenant-checked bytes: no image optimizer */}
                <img src={doc(d)} alt={d.filename ?? ""} loading="lazy" className="w-full rounded bg-white" />
              </a>
              <figcaption className="mt-1 truncate text-xs text-dim">{d.filename}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {tables.map(({ d, preview }) => preview && (
        <figure key={d.id} className="card mt-3 p-2">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-dim"><tr>{preview.headers.map((h, i) => <th key={i} className="whitespace-nowrap px-2 py-1">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-line-soft">
                {preview.rows.map((r, i) => <tr key={i}>{preview.headers.map((_, j) => <td key={j} className="num whitespace-nowrap px-2 py-1">{r[j] ?? ""}</td>)}</tr>)}
              </tbody>
            </table>
          </div>
          <figcaption className="mt-1 flex justify-between gap-2 text-xs text-dim">
            <span className="truncate">{d.filename}</span>
            {preview.more && <span>{t.csvFirstRows.replace("{n}", String(preview.rows.length))}</span>}
          </figcaption>
        </figure>
      ))}
      {files.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {files.map((d) => (
            <li key={d.id}>
              <a href={doc(d)} className="text-frost hover:underline">{d.filename ?? d.id}</a>
              {isPdf(d.contentType) && (
                <a href={`${doc(d)}?view=1`} target="_blank" rel="noreferrer" className="ml-2 text-xs text-frost hover:underline">{t.openPdf} ↗</a>
              )}
              <span className="ml-2 text-xs text-dim">{d.contentType} · <span className="num">{size(d)}</span>{previewed.has(d.id) ? ` · ${t.previewAbove}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** A result's pages in outside catalogs, from its project's template. */
export function OutsideLinks({ links, t }: { links: { label: string; url: string }[]; t: Dict }) {
  if (!links.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span className="text-dim">{t.outsideLinks}</span>
      {links.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noreferrer noopener" className="text-frost hover:underline">{l.label} ↗</a>)}
    </div>
  );
}
