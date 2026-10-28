"use client";
import { useFormStatus } from "react-dom";

export function SubmitButton({ children, pending: pendingLabel, className = "" }: { children: React.ReactNode; pending: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button disabled={pending} aria-busy={pending} className={`inline-flex items-center justify-center gap-2 disabled:opacity-70 ${className}`}>
      {pending && <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-950/30 border-t-ink-950" />}
      {pending ? pendingLabel : children}
    </button>
  );
}
