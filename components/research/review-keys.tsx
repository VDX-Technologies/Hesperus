"use client";
// The review queue's form: one button per review value, a note, and keys for each (i, d, s by
// default), j / k to move through the queue and n to write the note. Keys are ignored while
// typing; Escape leaves the note. The page passes a new `key` per result, so state starts over.
import { useActionState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { QuickReviewState } from "@/app/research/o/[slug]/actions";

export type ReviewChoice = { value: string; label: string; key?: string };

export function ReviewKeys({
  action, slug, id, choices, note, noteLabel, prev, next, labels,
}: {
  action: (prev: QuickReviewState, form: FormData) => Promise<QuickReviewState>;
  slug: string;
  id: string;
  choices: ReviewChoice[];
  /** the current note; null when the type has no note */
  note: string | null;
  noteLabel: string;
  prev: string | null;
  next: string | null;
  labels: { hint: string; previous: string; skip: string; saving: string; errors: Record<string, string> };
}) {
  const [state, submit, pending] = useActionState(action, null);
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable=true]")) {
        if (e.key === "Escape") el.blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || pending) return;
      const choice = choices.find((c) => c.key === e.key.toLowerCase());
      if (choice) {
        e.preventDefault();
        form.current?.querySelector<HTMLButtonElement>(`button[value="${choice.value}"]`)?.click();
      } else if (e.key === "j" && next) router.push(next);
      else if (e.key === "k" && prev) router.push(prev);
      else if (e.key === "n" && text.current) {
        e.preventDefault();
        text.current.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [choices, next, prev, pending, router]);

  return (
    <form ref={form} action={submit} className="card space-y-3 p-4 text-sm">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="id" value={id} />
      {note !== null && (
        <label className="block"><span className="text-xs text-dim">{noteLabel} <kbd className="num">n</kbd></span>
          <textarea ref={text} name="note" rows={4} defaultValue={note} className="mt-1 w-full" /></label>
      )}
      <div className="flex flex-wrap gap-2">
        {choices.map((c) => (
          <button key={c.value} name="review" value={c.value} disabled={pending} className="btn disabled:opacity-70">
            {c.label}{c.key && <kbd className="num ml-2 text-xs opacity-70">{c.key}</kbd>}
          </button>
        ))}
      </div>
      {pending && <p className="text-xs text-dim">{labels.saving}</p>}
      {state?.error && <p className="text-xs text-alarm">{labels.errors[state.error] ?? state.error}</p>}
      <div className="flex justify-between gap-3 text-xs">
        {prev ? <Link href={prev} className="text-frost hover:underline">← {labels.previous} <kbd className="num">k</kbd></Link> : <span />}
        {next && <Link href={next} className="text-frost hover:underline">{labels.skip} <kbd className="num">j</kbd> →</Link>}
      </div>
      <p className="text-xs text-dim">{labels.hint}</p>
    </form>
  );
}
