import webpush from "web-push";
import { forTenant } from "./db";
import { onAlert } from "./hooks";
import { getPackageDef } from "../packages/ui";
import type { Locale } from "../packages/types";

const clean = (v: string | undefined) => v?.trim().replace(/^["']|["']$/g, "") || undefined;
const vapidKey = (value: string | undefined, byteLength: number) => {
  const key = clean(value);
  if (!key || !/^(?:[A-Za-z0-9_-]+|[A-Za-z0-9+/]+)={0,2}$/.test(key)) return undefined;
  const normalized = key.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const bytes = Buffer.from(normalized, "base64url");
  return bytes.length === byteLength && bytes.toString("base64url") === normalized ? normalized : undefined;
};
const rawPub = clean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY);
const rawPriv = clean(process.env.VAPID_PRIVATE_KEY);
const pub = vapidKey(rawPub, 65);
const priv = vapidKey(rawPriv, 32);
const sub = clean(process.env.VAPID_SUBJECT);
const subject = sub && /^(mailto:\S+@\S+|https:\/\/\S+)$/.test(sub) ? sub : "mailto:info@vdxtechnologies.com";

let pushEnabled = false;
if (pub && priv) {
  try {
    webpush.setVapidDetails(subject, pub, priv);
    pushEnabled = true;
  } catch (error) {
    console.warn("Web push disabled: invalid VAPID configuration", error);
  }
}

if (pushEnabled) {
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
          url: `/terra/o/${a.slug}/devices/${t.objectId}`,
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
} else if ((rawPub || rawPriv) && (!pub || !priv)) {
  console.warn("Web push disabled: VAPID keys must be valid Base64 public (65-byte) and private (32-byte) keys");
}
