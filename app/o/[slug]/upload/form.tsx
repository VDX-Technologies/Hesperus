"use client";
import { useActionState, useRef, useState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { previewFile, uploadFile, type UploadState } from "./actions";

type Labels = Record<
  "uploadSource" | "uploadFile" | "uploadPick" | "uploadDrop" | "uploadChange" | "uploadMapping" | "uploadMappingHelp" | "uploadIgnore" | "uploadSend" | "uploadDone" | "uploadStored" | "uploadReading" | "uploadFound" | "uploadNoTable" | "uploadRejectedRows" | "uploadLine" | "uploadSending",
  string
> & { errors: Record<string, string> };

/** Picks the register and the file, reads the header row in the browser and lets the user map each column. */
export function UploadForm({
  slug,
  sources,
  fields,
  labels: l,
}: {
  slug: string;
  sources: { id: string; name: string; mapping: Record<string, string> }[];
  fields: { key: string; label: string; required: boolean }[];
  labels: Labels;
}) {
  const [state, action] = useActionState<UploadState, FormData>(uploadFile, null);
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  const [headers, setHeaders] = useState<string[]>([]);
  const [readError, setReadError] = useState(false);
  const [reading, setReading] = useState(false);
  const [found, setFound] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const mapping = sources.find((s) => s.id === sourceId)?.mapping ?? {};

  // the server reads the file (spreadsheet, PDF, Word, text…) and says which columns it found
  const readHeaders = async (file: File | undefined) => {
    setFile(file ?? null);
    setHeaders([]);
    setFound(null);
    setReadError(false);
    if (!file) return;
    setReading(true);
    try {
      const fd = new FormData();
      fd.set("slug", slug);
      fd.set("file", file);
      const p = await previewFile(fd);
      if ("error" in p) setReadError(true);
      else {
        setHeaders(p.headers);
        setFound(p.rows);
      }
    } catch {
      setReadError(true);
    } finally {
      setReading(false);
    }
  };

  // a column keeps its saved field, else one named like it
  const guess = (h: string) => mapping[h] ?? fields.find((f) => f.key === h.trim().toLowerCase() || f.label.toLowerCase() === h.trim().toLowerCase())?.key ?? "";

  // a dropped file goes into the real input, so the form submits it like a picked one
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (!f || !input.current) return;
    const dt = new DataTransfer();
    dt.items.add(f);
    input.current.files = dt.files;
    readHeaders(f);
  };

  return (
    <form action={action} className="card space-y-4 p-5">
      <input type="hidden" name="slug" value={slug} />
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-dim">{l.uploadSource}</span>
          <select name="source" value={sourceId} onChange={(e) => setSourceId(e.target.value)} className="mt-1 w-full">
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <div className="block text-sm">
          <span className="text-dim">{l.uploadFile}</span>
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`mt-1 flex cursor-pointer items-center gap-3 rounded-lg border border-dashed px-4 py-3 transition-colors hover:border-frost/60 hover:bg-steel/30 ${dragging ? "border-frost bg-steel/40" : "border-line"}`}
          >
            <input
              ref={input}
              name="file"
              type="file"
              required
              onChange={(e) => readHeaders(e.target.files?.[0])}
              className="sr-only"
            />
            <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-mist" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {file ? (
              <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                <span className="truncate font-medium text-ice">{file.name}</span>
                <span className="shrink-0 text-xs text-dim underline">{l.uploadChange}</span>
              </span>
            ) : (
              <span>
                <span className="font-medium text-ice">{l.uploadPick}</span> <span className="text-dim">{l.uploadDrop}</span>
              </span>
            )}
          </label>
        </div>
      </div>

      {reading && <p className="text-sm text-dim">{l.uploadReading}</p>}
      {readError && <p className="text-sm text-alarm">{l.errors.uploadErr_400}</p>}
      {found === 0 && !headers.length && <p className="text-sm text-dim">{l.uploadNoTable}</p>}
      {headers.length > 0 && (
        <div>
          <div className="text-sm font-medium">
            {l.uploadMapping} <span className="num font-normal text-dim">· {found} {l.uploadFound}</span>
          </div>
          <p className="mt-0.5 text-xs text-dim">{l.uploadMappingHelp}</p>
          <div className="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {headers.map((h) => (
              <label key={`${sourceId}:${h}`} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-mist" title={h}>
                  {h || "–"}
                </span>
                <select name={`map_${h}`} defaultValue={guess(h)} className="w-40 shrink-0">
                  <option value="">{l.uploadIgnore}</option>
                  {fields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                      {f.required ? " *" : ""}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>
      )}

      <SubmitButton pending={l.uploadSending} className="h-10 rounded-lg bg-frost px-4 text-sm font-medium text-ink-950 transition-colors hover:bg-white">
        {l.uploadSend}
      </SubmitButton>

      {state?.error && <p className="text-sm text-alarm">{l.errors[state.error] ?? state.error}</p>}
      {state?.result && (
        <div className="space-y-2 text-sm">
          <p className="text-ok">
            {state.result.table ? `${state.result.accepted} / ${state.result.rows} ${l.uploadDone}` : l.uploadStored}
          </p>
          {state.result.rejected.length > 0 && (
            <div className="rounded-lg border border-warn/50 bg-warn/10 p-3">
              <div className="text-warn">
                {state.result.rejected.length} {l.uploadRejectedRows}
              </div>
              <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto text-xs text-mist">
                {state.result.rejected.map((r) => (
                  <li key={r.line}>
                    {l.uploadLine} <span className="num">{r.line}</span>: {r.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </form>
  );
}
