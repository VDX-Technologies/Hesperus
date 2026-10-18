import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { crossTenantDb } from "@/lib/engine/db";
import { alertRecipients } from "@/lib/engine/health";
import { mailerFromEnv } from "@/lib/engine/mail";
import { getSettings, num } from "@/lib/engine/settings";
import { SectionTitle } from "@/components/ui";
import { display, GROUPS, HIDDEN, parse } from "@/lib/engine/setting-fields";

const PATH = "/admin/settings";

async function flash(msg: string) {
  (await cookies()).set("settings_flash", msg, { path: PATH, maxAge: 30, httpOnly: true, sameSite: "strict" });
  redirect(PATH);
}

const put = (key: string, value: unknown) =>
  crossTenantDb("settings").query(`update engine_settings set value = $2 where key = $1`, [key, JSON.stringify(value)]);

async function saveAlerts(formData: FormData) {
  "use server";
  await requireAdmin();
  const to = String(formData.get("to")).split(/[\s,;]+/).filter((x) => x.includes("@"));
  await put("alerts.email_to", to);
  await put("alerts.email_from", String(formData.get("from")).trim());
  const h = Number(formData.get("repeat"));
  if (h > 0) await put("alerts.repeat_h", h);
  await flash("ok");
}

async function sendTest() {
  "use server";
  await requireAdmin();
  const mailer = mailerFromEnv();
  if (!mailer) return flash("error: RESEND_API_KEY");
  const db = crossTenantDb("settings");
  const to = await alertRecipients(db);
  try {
    await mailer.send({
      from: String((await getSettings(db, true))["alerts.email_from"]),
      to,
      subject: "[VDX] Test alert",
      text: "Health alerts from VDX Core reach this address.",
    });
  } catch (e) {
    return flash(`error: ${(e as Error).message}`);
  }
  await flash(`sent:${to.join(", ")}`);
}

async function saveGroup(formData: FormData) {
  "use server";
  await requireAdmin();
  const group = GROUPS.find((g) => g.id === formData.get("group"));
  if (!group) return;
  const values = group.fields.map((f) => [f.key, parse(f, String(formData.get(f.key) ?? ""), String(formData.get(`${f.key}:unit`) ?? "0"))] as const);
  const bad = values.find(([, v]) => v instanceof Error);
  if (bad) return flash(`error: ${bad[0]}`);
  for (const [key, v] of values) await put(key, v);
  await flash("ok");
}

async function saveSetting(formData: FormData) {
  "use server";
  await requireAdmin();
  const key = String(formData.get("key"));
  try {
    await put(key, JSON.parse(String(formData.get("value"))));
  } catch (e) {
    return flash(`error: ${key}: ${(e as Error).message}`);
  }
  await flash("ok");
}

export default async function SettingsPage() {
  await requireAdmin();
  const { t, locale } = await getT();
  const db = crossTenantDb("settings");
  const s = await getSettings(db, true);
  const { rows } = await db.query<{ key: string; value: unknown; description: string | null }>(
    `select key, value, description from engine_settings order by key`,
  );
  const msg = (await cookies()).get("settings_flash")?.value;
  const known = new Set(GROUPS.flatMap((g) => g.fields.map((f) => f.key)));
  const other = rows.filter((r) => !known.has(r.key) && !HIDDEN.has(r.key));
  const description = new Map(rows.map((r) => [r.key, r.description]));
  const to = Array.isArray(s["alerts.email_to"]) ? (s["alerts.email_to"] as string[]) : [];

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t.engineSettings}</h1>
      {msg && (
        <div className={`mt-4 rounded-lg border p-3 text-sm ${msg.startsWith("error") ? "border-alarm/50 text-alarm" : "border-ok/50 text-ok"}`}>
          {msg === "ok" ? t.save + " ✓" : msg.startsWith("sent:") ? `${t.testSent} ${msg.slice(5)}` : msg}
        </div>
      )}

      <SectionTitle>{t.alerts}</SectionTitle>
      <div className="card p-5 text-sm">
        {!mailerFromEnv() && <p className="mb-4 text-warn">{t.mailOff}</p>}
        <form action={saveAlerts} className="grid gap-4 sm:max-w-lg">
          <label className="grid gap-1">
            <span>{t.recipients}</span>
            <textarea name="to" rows={3} defaultValue={to.join("\n")} />
            <span className="text-xs text-dim">{t.recipientsHelp}</span>
          </label>
          <label className="grid gap-1">
            <span>{t.sender}</span>
            <input name="from" defaultValue={String(s["alerts.email_from"] ?? "")} required />
          </label>
          <label className="grid gap-1">
            <span>{t.repeatEvery}</span>
            <input name="repeat" type="number" min={1} defaultValue={num(s, "alerts.repeat_h", 24)} />
          </label>
          <div className="flex gap-2">
            <button className="btn">{t.save}</button>
            <button className="btn" formAction={sendTest} formNoValidate>
              {t.sendTest}
            </button>
          </div>
        </form>
      </div>

      <div className="grid gap-x-4 lg:grid-cols-2">
        {GROUPS.map((g) => (
          <div key={g.id}>
            <SectionTitle>{g.title[locale]}</SectionTitle>
            <form action={saveGroup} className="card grid gap-3 p-5 text-sm">
              <input type="hidden" name="group" value={g.id} />
              {g.fields.map((f) => {
                const { amount, unit } = display(f, s[f.key]);
                return (
                  <label key={f.key} className="flex items-center gap-3" title={description.get(f.key) ?? f.key}>
                    <span className="flex-1">{f.label[locale]}</span>
                    <input
                      name={f.key}
                      inputMode="decimal"
                      defaultValue={amount}
                      placeholder={f.nullable?.[locale]}
                      required={!f.nullable}
                      className="num w-24 text-right"
                    />
                    {f.units.length > 1 ? (
                      <select name={`${f.key}:unit`} defaultValue={unit} className="w-16">
                        {f.units.map((u, i) => (
                          <option key={i} value={i}>
                            {u.label || "×1"}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="w-16 text-dim">{f.units[0].label}</span>
                    )}
                  </label>
                );
              })}
              <div>
                <button className="btn text-xs">{t.save}</button>
              </div>
            </form>
          </div>
        ))}
      </div>

      {!!other.length && (
        <>
          <SectionTitle>{t.allSettings}</SectionTitle>
          <div className="card divide-y divide-line p-5 text-sm">
            {other.map((r) => (
              <form key={r.key} action={saveSetting} className="flex flex-wrap items-center gap-2 py-2">
                <input type="hidden" name="key" value={r.key} />
                <div className="min-w-56 flex-1">
                  <div className="num font-medium">{r.key}</div>
                  {r.description && <div className="text-xs text-dim">{r.description}</div>}
                </div>
                <input name="value" defaultValue={JSON.stringify(r.value)} className="num w-64" />
                <button className="btn text-xs">{t.save}</button>
              </form>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
