import type { Metadata } from "next";
import Image from "next/image";
import { unstable_cache } from "next/cache";
import { getT } from "@/lib/i18n";
import { crossTenantAccess, crossTenantDb } from "@/lib/engine/db";
import { readStatus, type Component, type Level } from "@/lib/engine/status";

export const metadata: Metadata = { title: "Status" };

// public and unauthenticated: one query a minute at most, whatever the traffic
const status = unstable_cache(() => readStatus(crossTenantDb(crossTenantAccess.maintenance)), ["platform-status"], { revalidate: 60 });

const COMPONENTS: Component[] = ["database", "ingest", "storage", "monitoring"];
const TONE: Record<Level, string> = { ok: "text-ok", degraded: "text-warn", down: "text-alarm", unknown: "text-offline" };
const DOT: Record<Level, string> = { ok: "bg-ok", degraded: "bg-warn", down: "bg-alarm", unknown: "bg-offline" };

export default async function StatusPage() {
  const { t, locale } = await getT();
  const s = await status();
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Rome" });

  return (
    <main className="safe-y mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-6 py-10">
      <div className="flex items-center gap-3">
        <Image src="/vdx-symbol.png" alt="" width={32} height={32} priority />
        <div className="text-lg font-semibold tracking-tight">
          VDX <span className="font-normal text-mist">Core</span>
        </div>
      </div>

      <h1 className="mt-10 text-2xl font-semibold tracking-tight">{t.statusTitle}</h1>
      <div className="card mt-6 flex items-center gap-3 p-5">
        <span className={`size-2.5 shrink-0 rounded-full ${DOT[s.overall]}`} aria-hidden />
        <span className={`font-medium ${TONE[s.overall]}`}>{t[`statusOverall_${s.overall}`]}</span>
      </div>

      <div className="card mt-4 divide-y divide-line-soft">
        {COMPONENTS.map((c) => (
          <div key={c} className="flex items-center justify-between gap-3 px-5 py-3.5 text-sm">
            <span>{t[`statusComponent_${c}`]}</span>
            <span className={`flex items-center gap-2 ${TONE[s.components[c]]}`}>
              <span className={`size-2 rounded-full ${DOT[s.components[c]]}`} aria-hidden />
              {t[`statusLevel_${s.components[c]}`]}
            </span>
          </div>
        ))}
      </div>

      <p className="mt-4 text-xs text-dim">
        {t.statusCheckedAt}: <span className="num">{s.checkedAt ? fmt.format(new Date(s.checkedAt)) : t.never}</span>. {t.statusRefresh}
      </p>
      <p className="mt-auto pt-10 text-xs text-dim">© {new Date().getFullYear()} VDX Technologies</p>
    </main>
  );
}
