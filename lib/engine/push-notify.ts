// Web push for alarms: every browser subscribed to the organization (push_subscriptions) gets a
// notification when a warning or alarm opens. Registered as an alert hook; ingest imports this module.
import webpush from "web-push";
import { forTenant } from "./db";
import { onAlert } from "./hooks";
import { getPackageDef } from "../packages/ui";
import type { Locale } from "../packages/types";

// env values pasted into a dashboard often carry quotes, spaces or a newline: web-push rejects them and
// the whole build fails, so clean them and fall back to the default contact
const clean = (v: string | undefined) => v?.trim().replace(/^["']|["']$/g, "") || undefined;
const pub = clean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY);
const priv = clean(process.env.VAPID_PRIVATE_KEY);
const sub = clean(process.env.VAPID_SUBJECT);
const subject = sub && /^(mailto:\S+@\S+|https:\/\/\S+)$/.test(sub) ? sub : "mailto:info@vdxtechnologies.com";

if (pub && priv) {
  webpush.setVapidDetails(subject, pub, priv);

  onAlert(async (t, raw) => {
    if (t.kind !== "opened" || (t.severity !== "warn" && t.severity !== "alarm")) return;
    const db = forTenant(raw, t.tenantId);
    const [{ rows: [a] }, { rows: subs }] = await Promise.all([
      db.query<{ slug: string; object: string; title: string | null; key: string | null; threshold: number | null; module: string | null }>(
        `select g.slug, coalesce(o.name, o.external_id) object, a.title, r.key, r.threshold, r.module
         from object_alerts a join organizations g on g.id = a.tenant_id
           join objects o on o.tenant_id = a.tenant_id and o.id = a.object_id left join rules r on r.id = a.rule_id
         where a.tenant_id = $1 and a.id = $2`,
        [t.tenantId, t.alertId],
      ),
      db.query<{ endpoint: string; p256dh: string; auth: string; locale: Locale }>(
        `select endpoint, p256dh, auth, locale from push_subscriptions where tenant_id = $1`,
        [t.tenantId],
      ),
    ]);
    if (!a || !subs.length) return;
    const pkg = a.module ? getPackageDef(a.module) : null;
    const text = (locale: Locale) => {
      const key = a.key ?? a.title ?? t.ruleKey;
      return pkg ? pkg.alertText(key, { value: t.value, limit: a.threshold }, locale) : (a.title ?? key);
    };
    await Promise.all(
      subs.map(async (s) => {
        const prefix = t.severity === "alarm" ? (s.locale === "it" ? "Allarme" : "Alarm") : s.locale === "it" ? "Avviso" : "Warning";
        const payload = JSON.stringify({
          title: `${prefix} · ${a.object}`,
          body: text(s.locale),
          tag: `alert-${t.alertId}`,
          severity: t.severity,
          url: `/o/${a.slug}/devices/${t.objectId}`,
        });
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 6 * 3600, urgency: "high" });
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410)
            await db.query(`delete from push_subscriptions where tenant_id = $1 and endpoint = $2`, [t.tenantId, s.endpoint]);
          else console.error("push failed", code, e);
        }
      }),
    );
  });
}
