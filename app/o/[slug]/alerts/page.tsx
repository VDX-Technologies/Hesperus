import { revalidatePath } from "next/cache";
import { requireOrg } from "@/lib/auth";
import { getT, timeAgo } from "@/lib/i18n";
import { tenantDb } from "@/lib/engine/db";
import { listAlerts, type ConsoleAlert } from "@/lib/packages/console";
import { SectionTitle, StatusDot } from "@/components/ui";
import { PushToggle } from "@/components/push-toggle";

/** Acknowledging only marks the alert as seen; the engine resolves it when the value recovers. */
async function ackAlert(formData: FormData) {
  "use server";
  const slug = String(formData.get("slug"));
  const { supabase } = await requireOrg(slug);
  await supabase.rpc("ack_alert", { alert_id: Number(formData.get("id")) });
  revalidatePath(`/o/${slug}`, "layout");
}

export default async function Alerts(props: PageProps<"/o/[slug]/alerts">) {
  const { slug } = await props.params;
  const { org, role } = await requireOrg(slug);
  const { t, locale } = await getT();
  const db = tenantDb(org.id);
  const [open, closed] = await Promise.all([
    listAlerts(db, locale, { limit: 200 }),
    listAlerts(db, locale, { history: true, limit: 200 }),
  ]);
  const Row = ({ a }: { a: ConsoleAlert }) => (
    <li className="flex items-start gap-3 px-4 py-3 sm:items-center sm:px-5">
      <span className="mt-1.5 flex sm:mt-0">
        <StatusDot status={a.status === "resolved" ? "offline" : a.severity === "alarm" ? "alarm" : "warn"} pulse={a.status === "open"} />
      </span>
      {/* stacked on phones, one line on wider screens */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
        <span className="text-sm text-mist sm:w-28 sm:shrink-0">{a.object}</span>
        <span className="text-sm sm:flex-1">{a.text}</span>
        <span className="text-xs text-dim">
          {new Date(a.openedAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}
          {a.resolvedAt && ` → ${t.resolved} ${timeAgo(a.resolvedAt, locale, t)}`}
          {a.status === "acknowledged" && ` · ${t.acknowledged}`}
        </span>
      </div>
      {a.status === "open" && role !== "viewer" && (
        <form action={ackAlert} className="shrink-0">
          <input type="hidden" name="id" value={a.id} />
          <input type="hidden" name="slug" value={slug} />
          <button className="btn text-xs">{t.resolve}</button>
        </form>
      )}
    </li>
  );
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t.alerts}</h1>
      <div className="mt-4">
        <PushToggle
          slug={slug}
          labels={{
            title: t.push_title,
            on: t.push_on,
            off: t.push_off,
            enable: t.push_enable,
            disable: t.push_disable,
            denied: t.push_denied,
            unsupported: t.push_unsupported,
            install: t.push_install,
          }}
        />
      </div>
      <SectionTitle>{t.openAlerts}</SectionTitle>
      {open.length ? (
        <ul className="card divide-y divide-line-soft">{open.map((a) => <Row key={a.id} a={a} />)}</ul>
      ) : (
        <p className="text-sm text-mist">{t.noAlerts}</p>
      )}
      <SectionTitle>{t.history}</SectionTitle>
      <ul className="card divide-y divide-line-soft">{closed.map((a) => <Row key={a.id} a={a} />)}</ul>
    </div>
  );
}
