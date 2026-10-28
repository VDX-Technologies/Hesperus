import type { AuditEntry } from "@/lib/engine/audit";
import type { Locale } from "@/lib/packages/types";
import type { Dict } from "@/lib/i18n";

export function ActivityList({ entries, t, locale, names = {} }: { entries: AuditEntry[]; t: Dict; locale: Locale; names?: Record<string, string> }) {
  if (!entries.length) return <p className="text-sm text-mist">{t.noActivity}</p>;
  return (
    <ul className="card divide-y divide-line-soft">
      {entries.map((e) => {
        const verb = (t as Record<string, string>)[`act_${e.action}`] ?? e.action;
        const target = e.subject ?? (e.objectId ? names[e.objectId] : undefined);
        return (
          <li key={e.id} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-center sm:gap-3 sm:px-5">
            <span className="num text-xs text-dim sm:w-36 sm:shrink-0">
              {new Date(e.at).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}
            </span>
            <span className="min-w-0 break-words text-sm">
              <span className="text-mist">{e.actorLabel ?? t.system}</span> {verb}
              {target && <span className="text-frost"> {target}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
