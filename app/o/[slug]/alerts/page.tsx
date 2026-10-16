import { revalidatePath } from "next/cache";
import { requireOrg } from "@/lib/auth";
import { getT, timeAgo } from "@/lib/i18n";
import { alertMessage } from "@/lib/modules";
import { SectionTitle, StatusDot } from "@/components/ui";

async function resolveAlert(formData: FormData) {
  "use server";
  const slug = String(formData.get("slug"));
  const { supabase } = await requireOrg(slug);
  await supabase.from("alerts").update({ resolved_at: new Date().toISOString() }).eq("id", Number(formData.get("id")));
  revalidatePath(`/o/${slug}/alerts`);
}

export default async function Alerts(props: PageProps<"/o/[slug]/alerts">) {
  const { slug } = await props.params;
  const { supabase, org, role } = await requireOrg(slug);
  const { t, locale } = await getT();
  const { data } = await supabase
    .from("alerts")
    .select("id, ts, level, code, params, resolved_at, devices(name)")
    .eq("org_id", org.id)
    .order("ts", { ascending: false })
    .limit(200);
  const open = (data ?? []).filter((a) => !a.resolved_at);
  const closed = (data ?? []).filter((a) => a.resolved_at);
  const Row = ({ a }: { a: (typeof open)[number] }) => (
    <li className="flex items-start gap-3 px-4 py-3 sm:items-center sm:px-5">
      <span className="mt-1.5 flex sm:mt-0">
        <StatusDot status={a.resolved_at ? "offline" : a.level === "alarm" ? "alarm" : "warn"} />
      </span>
      {/* stacked on phones, one line on wider screens */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
        <span className="text-sm text-mist sm:w-28 sm:shrink-0">{(a.devices as unknown as { name: string })?.name}</span>
        <span className="text-sm sm:flex-1">{alertMessage(a.code, a.params, locale)}</span>
        <span className="text-xs text-dim">
          {new Date(a.ts).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}
          {a.resolved_at && ` → ${t.resolved} ${timeAgo(a.resolved_at, locale, t)}`}
        </span>
      </div>
      {!a.resolved_at && role !== "viewer" && (
        <form action={resolveAlert} className="shrink-0">
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
