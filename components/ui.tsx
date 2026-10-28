import type { Status } from "@/lib/packages/types";
import type { Dict } from "@/lib/i18n";

const COLOR: Record<Status, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  alarm: "bg-alarm",
  offline: "bg-offline",
};
const TEXT: Record<Status, string> = {
  ok: "text-ok",
  warn: "text-warn",
  alarm: "text-alarm",
  offline: "text-offline",
};

export function StatusDot({ status, pulse = false }: { status: Status; pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-2.5 w-2.5">
      {pulse && status === "alarm" && (
        <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${COLOR[status]}`} />
      )}
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${COLOR[status]}`} />
    </span>
  );
}

export function StatusLabel({ status, t }: { status: Status; t: Dict }) {
  return (
    <span className={`inline-flex items-center gap-2 text-sm ${TEXT[status]}`}>
      <StatusDot status={status} pulse />
      {t[`status_${status}`]}
    </span>
  );
}

export function liveStatus(lastStatus: string | null, lastSeen: string | null, offlineAfterS: number): Status {
  if (!lastSeen || Date.now() - Date.parse(lastSeen) > offlineAfterS * 1000) return "offline";
  return (lastStatus as Status) ?? "offline";
}

export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-3 mt-8 flex items-end justify-between gap-4">
      <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-dim">{children}</h2>
      {right}
    </div>
  );
}

export function fmt(v: number | null | undefined, decimals: number, locale: string) {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  return v.toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
