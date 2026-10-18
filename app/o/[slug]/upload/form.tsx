"use client";
import { useActionState, useState } from "react";
import { parseCsv } from "@/lib/engine/csv";
import { SubmitButton } from "@/components/submit-button";
import { uploadFile, type UploadState } from "./actions";

type Labels = Record<
  "uploadSource" | "uploadFile" | "uploadMapping" | "uploadMappingHelp" | "uploadIgnore" | "uploadSend" | "uploadDone" | "uploadRejectedRows" | "uploadLine" | "uploadSending",
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
  const mapping = sources.find((s) => s.id === sourceId)?.mapping ?? {};

  const readHeaders = async (file: File | undefined) => {
    setHeaders([]);
    setReadError(false);
    if (!file) return;
    try {
      // the header row is enough: read only the start of the file
      const head = await file.slice(0, 64 * 1024).text();
      setHeaders(parseCsv(head.slice(0, head.search(/\r?\n|$/))).headers.filter(Boolean));
    } catch {
      setReadError(true);
    }
  };

  // a column keeps its saved field, else one named like it
  const guess = (h: string) => mapping[h] ?? fields.find((f) => f.key === h.trim().toLowerCase() || f.label.toLowerCase() === h.trim().toLowerCase())?.key ?? "";

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
        <label className="block text-sm">
          <span className="text-dim">{l.uploadFile}</span>
          <input name="file" type="file" accept=".csv,text/csv,text/plain" required onChange={(e) => readHeaders(e.target.files?.[0])} className="mt-1 w-full" />
        </label>
      </div>

      {readError && <p className="text-sm text-alarm">{l.errors.uploadErr_400}</p>}
      {headers.length > 0 && (
        <div>
          <div className="text-sm font-medium">{l.uploadMapping}</div>
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
            {state.result.accepted} / {state.result.rows} {l.uploadDone}
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
