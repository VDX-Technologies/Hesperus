"use server";
import { requireOrg } from "@/lib/auth";
import { tenantDb } from "@/lib/engine/db";
import { getLocale } from "@/lib/i18n";

export interface PushKeys {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Stores this browser's push subscription for the organization (any member, viewers included). */
export async function subscribePush(slug: string, sub: PushKeys, userAgent: string) {
  const { user, org } = await requireOrg(slug);
  if (!/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error("invalid subscription");
  await tenantDb(org.id).query(
    `insert into push_subscriptions (tenant_id, endpoint, user_id, p256dh, auth, locale, user_agent) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (tenant_id, endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
       locale = excluded.locale, user_agent = excluded.user_agent`,
    [org.id, sub.endpoint, user.id, sub.keys.p256dh, sub.keys.auth, await getLocale(), userAgent.slice(0, 300)],
  );
}

export async function unsubscribePush(slug: string, endpoint: string) {
  const { user, org } = await requireOrg(slug);
  await tenantDb(org.id).query(`delete from push_subscriptions where tenant_id = $1 and endpoint = $2 and user_id = $3`, [org.id, endpoint, user.id]);
}
