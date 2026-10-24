import { getConsent } from "@/lib/consent";
import { getT } from "@/lib/i18n";
import { ConsentSettings } from "@/components/consent-settings";
import { requireConsole } from "@/lib/auth";

export default async function Settings(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  const { supabase, user, isAdmin } = await requireConsole(slug, "research");
  const { t } = await getT();
  const consent = isAdmin ? null : await getConsent(supabase, user.id);
  return <div>
    <h1 className="text-2xl font-semibold tracking-tight">{t.settings}</h1>
    {consent && <div className="mt-6"><ConsentSettings consent={consent} slug={slug} back={`/research/o/${slug}/settings`} /></div>}
  </div>;
}
