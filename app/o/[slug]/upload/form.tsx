"use client";
import { useRef, useState } from "react";
import { previewFile, uploadFile, type Preview, type UploadState } from "./actions";

type Labels = Record<
  | "uploadSource" | "uploadPick" | "uploadDrop" | "uploadMappingHelp" | "uploadIgnore" | "uploadSend" | "uploadDone"
  | "uploadStored" | "uploadReading" | "uploadFound" | "uploadNoTable" | "uploadRejectedRows" | "uploadLine" | "uploadSending"
  | "uploadSendReady" | "uploadReady" | "uploadReview" | "uploadKnown" | "uploadMissing" | "uploadRemove" | "uploadClear"
  | "uploadSure" | "uploadUnsure",
  string
> & { errors: Record<string, string> };

type Status = "reading" | "ready" | "review" | "sending" | "done" | "error";

interface Item {
  id: number;
  file: File;
  status: Status;
  preview?: Extract<Preview, { headers: string[] }>;
  mapping: Record<string, string>;
  confidence: Record<string, number>;
  result?: UploadState;
  error?: string;
}

/** Below this a column is shown for review; a file with every column above it can go in one click. */
const SURE = 0.75;

let next = 1;

/**
 * Upload queue: any number of files are read on the server, every column is recognised with how
 * sure the guess is, files that are fully recognised are ready to send, the others open for review
 * of the doubtful columns only.
 */
export function UploadForm({
  slug,
  sources,
  fields,
  labels: l,
}: {
  slug: string;
  sources: { id: string; name: string }[];
  fields: { key: string; label: string; required: boolean }[];
  labels: Labels;
}) {
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  const [items, setItems] = useState<Item[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const required = fields.filter((f) => f.required).map((f) => f.key);
  const label = (k: string) => fields.find((f) => f.key === k)?.label ?? k;

  const patch = (id: number, p: Partial<Item>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const missing = (it: Item) => (it.preview?.headers.length ? required.filter((f) => !Object.values(it.mapping).includes(f)) : []);
  const doubtful = (it: Item) => it.preview?.headers.filter((h) => (it.confidence[h] ?? 1) < SURE) ?? [];
  const settle = (it: Item): Status => (missing(it).length || doubtful(it).length ? "review" : "ready");

  const read = async (it: Item, source = sourceId) => {
    patch(it.id, { status: "reading", error: undefined });
    try {
      const fd = new FormData();
      fd.set("slug", slug);
      fd.set("source", source);
      fd.set("file", it.file);
      const p = await previewFile(fd);
      if ("error" in p) return patch(it.id, { status: "error", error: p.error });
      const cols = p.recognition?.columns ?? [];
      const done: Item = {
        ...it,
        preview: p,
        mapping: Object.fromEntries(cols.map((c) => [c.header, c.field])),
        confidence: Object.fromEntries(cols.map((c) => [c.header, c.confidence])),
      };
      const status = settle(done);
      patch(it.id, { ...done, status });
      // a layout confirmed before goes straight in
      if (p.recognition?.known && status === "ready") await send(done);
    } catch {
      patch(it.id, { status: "error", error: "uploadErr_400" });
    }
  };

  const add = (files: FileList | File[]) => {
    const fresh = [...files].map((file): Item => ({ id: next++, file, status: "reading", mapping: {}, confidence: {} }));
    setItems((xs) => [...xs, ...fresh]);
    // two at a time: big batches do not flood the server
    const queue = [...fresh];
    const worker = async () => {
      for (let it = queue.shift(); it; it = queue.shift()) await read(it);
    };
    void Promise.all([worker(), worker()]);
  };

  const send = async (it: Item) => {
    patch(it.id, { status: "sending" });
    const fd = new FormData();
    fd.set("slug", slug);
    fd.set("source", sourceId);
    fd.set("file", it.file);
    for (const [h, f] of Object.entries(it.mapping)) if (f) fd.set(`map_${h}`, f);
    try {
      const r = await uploadFile(null, fd);
      patch(it.id, r?.error ? { status: "error", error: r.error, result: r } : { status: "done", result: r });
    } catch {
      patch(it.id, { status: "error", error: "uploadErr_400" });
    }
  };

  const sendReady = async () => {
    for (const it of items.filter((x) => x.status === "ready")) await send(it);
  };

  // a column changed by hand is sure: the user said so
  const setField = (it: Item, header: string, field: string) => {
    const mapping = { ...it.mapping };
    // a field fills one column only
    for (const h in mapping) if (field && mapping[h] === field) mapping[h] = "";
    mapping[header] = field;
    const changed: Item = { ...it, mapping, confidence: { ...it.confidence, [header]: 1 } };
    patch(it.id, { mapping, confidence: changed.confidence, status: settle(changed) });
  };

  const changeSource = (id: string) => {
    setSourceId(id);
    // each register has its own memory: open files are read again against it
    for (const it of items) if (it.status !== "done" && it.status !== "sending") void read(it, id);
  };

  const ready = items.filter((x) => x.status === "ready").length;
  const tone = (c: number) => (c >= SURE ? "border-ok/50 bg-ok/10" : c >= 0.5 ? "border-warn/60 bg-warn/10" : "border-alarm/60 bg-alarm/10");

  return (
    <div className="card space-y-4 p-5">
      <div className="grid gap-4 sm:grid-cols-[16rem_1fr]">
        <label className="block text-sm">
          <span className="text-dim">{l.uploadSource}</span>
          <select value={sourceId} onChange={(e) => changeSource(e.target.value)} className="mt-1 w-full">
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            add(e.dataTransfer.files);
          }}
          className={`flex cursor-pointer items-center gap-3 self-end rounded-lg border border-dashed px-4 py-3 text-sm transition-colors hover:border-frost/60 hover:bg-steel/30 ${dragging ? "border-frost bg-steel/40" : "border-line"}`}
        >
          <input
            ref={input}
            type="file"
            multiple
            onChange={(e) => {
              if (e.target.files) add(e.target.files);
              e.target.value = "";
            }}
            className="sr-only"
          />
          <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-mist" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>
            <span className="font-medium text-ice">{l.uploadPick}</span> <span className="text-dim">{l.uploadDrop}</span>
          </span>
        </label>
      </div>

      {items.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-soft pt-4">
            <p className="num text-xs text-dim">
              {items.length} file · {ready} {l.uploadReady} · {items.filter((x) => x.status === "review").length} {l.uploadReview} ·{" "}
              {items.filter((x) => x.status === "done").length} {l.uploadDone}
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setItems((xs) => xs.filter((x) => x.status !== "done"))} className="h-9 rounded-lg border border-line px-3 text-sm text-mist hover:text-ice">
                {l.uploadClear}
              </button>
              <button
                type="button"
                disabled={!ready}
                onClick={sendReady}
                className="h-9 rounded-lg bg-frost px-4 text-sm font-medium text-ink-950 transition-colors hover:bg-white disabled:opacity-40"
              >
                {l.uploadSendReady} ({ready})
              </button>
            </div>
          </div>

          <ul className="divide-y divide-line-soft rounded-lg border border-line-soft">
            {items.map((it) => {
              const p = it.preview;
              const miss = missing(it);
              const unsure = doubtful(it);
              const expanded = open === it.id || (it.status === "review" && open === null && items.find((x) => x.status === "review")?.id === it.id);
              const cols = p?.headers ?? [];
              const known = p?.recognition?.known;
              return (
                <li key={it.id} className="text-sm">
                  <div className="flex items-center gap-3 px-3 py-2.5">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        it.status === "done" ? "bg-ok" : it.status === "error" ? "bg-alarm" : it.status === "review" ? "bg-warn" : it.status === "ready" ? "bg-frost" : "animate-pulse bg-mist"
                      }`}
                    />
                    <button type="button" onClick={() => setOpen(expanded ? -1 : it.id)} className="min-w-0 flex-1 truncate text-left font-medium text-ice" title={it.file.name}>
                      {it.file.name}
                    </button>
                    <span className="num shrink-0 text-xs text-dim">
                      {it.status === "reading" && l.uploadReading}
                      {it.status === "sending" && l.uploadSending}
                      {(it.status === "ready" || it.status === "review") &&
                        (cols.length ? `${p?.rows} ${l.uploadFound}${known ? ` · ${l.uploadKnown}` : ""}` : l.uploadNoTable)}
                      {it.status === "review" && unsure.length > 0 && <span className="ml-2 text-warn">{unsure.length} {l.uploadUnsure}</span>}
                      {it.status === "review" && miss.length > 0 && (
                        <span className="ml-2 text-alarm">
                          {l.uploadMissing}: {miss.map(label).join(", ")}
                        </span>
                      )}
                      {it.status === "done" && it.result?.result && (
                        <span className="text-ok">
                          {it.result.result.table ? `${it.result.result.accepted} / ${it.result.result.rows} ${l.uploadDone}` : l.uploadStored}
                          {it.result.result.rejected.length > 0 && (
                            <span className="ml-2 text-warn">
                              {it.result.result.rejected.length} {l.uploadRejectedRows}
                            </span>
                          )}
                        </span>
                      )}
                      {it.status === "error" && <span className="text-alarm">{l.errors[it.error ?? ""] ?? it.error}</span>}
                    </span>
                    {(it.status === "ready" || it.status === "review") && (
                      <button
                        type="button"
                        disabled={miss.length > 0}
                        onClick={() => send(it)}
                        className="h-7 shrink-0 rounded-md border border-line px-2.5 text-xs text-ice hover:border-frost/60 disabled:opacity-40"
                      >
                        {l.uploadSend}
                      </button>
                    )}
                    {it.status !== "sending" && (
                      <button type="button" onClick={() => setItems((xs) => xs.filter((x) => x.id !== it.id))} className="shrink-0 text-dim hover:text-ice" aria-label={l.uploadRemove} title={l.uploadRemove}>
                        ×
                      </button>
                    )}
                  </div>

                  {expanded && cols.length > 0 && it.status !== "done" && (
                    <div className="space-y-2 px-3 pb-3">
                      <p className="text-xs text-dim">
                        {l.uploadMappingHelp} <span className="text-ok">■</span> {l.uploadSure} <span className="text-warn">■</span> {l.uploadUnsure}
                      </p>
                      <div className="overflow-x-auto rounded-lg border border-line-soft">
                        <table className="w-full text-xs">
                          <thead>
                            <tr>
                              {cols.map((h) => {
                                const c = it.confidence[h] ?? 0;
                                return (
                                  <th key={h} className="min-w-36 p-1.5 text-left align-top font-normal">
                                    <div className="truncate text-mist" title={h}>
                                      {h}
                                    </div>
                                    <div className={`mt-1 flex items-center gap-1 rounded-md border px-1 ${tone(c)}`}>
                                      <select
                                        value={it.mapping[h] ?? ""}
                                        onChange={(e) => setField(it, h, e.target.value)}
                                        disabled={it.status === "sending"}
                                        className="min-w-0 flex-1 border-0 bg-transparent py-1 text-xs"
                                      >
                                        <option value="">{l.uploadIgnore}</option>
                                        {fields.map((f) => (
                                          <option key={f.key} value={f.key}>
                                            {f.label}
                                            {f.required ? " *" : ""}
                                          </option>
                                        ))}
                                      </select>
                                      <span className="num shrink-0 text-[10px] text-dim">{Math.round(c * 100)}%</span>
                                    </div>
                                  </th>
                                );
                              })}
                            </tr>
                          </thead>
                          <tbody className="num">
                            {p?.sample.map((r, i) => (
                              <tr key={i} className="border-t border-line-soft">
                                {cols.map((h, k) => (
                                  <td key={h} className={`max-w-48 truncate p-1.5 ${it.mapping[h] ? "text-ice" : "text-dim line-through decoration-dim/40"}`}>
                                    {r[k]}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {it.status === "done" && expanded && (it.result?.result?.rejected.length ?? 0) > 0 && (
                    <ul className="max-h-48 space-y-0.5 overflow-y-auto px-3 pb-3 text-xs text-mist">
                      {it.result!.result!.rejected.map((r) => (
                        <li key={r.line}>
                          {l.uploadLine} <span className="num">{r.line}</span>: {r.error}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
