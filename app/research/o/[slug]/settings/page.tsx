import { requireConsole } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { getConsent } from "@/lib/consent";
import { Flash } from "@/components/flash";
import { ConsentSettings } from "@/components/consent-settings";

/** The person's own settings in Research: the consent they signed. */
export default async function Settings(props: PageProps<"/research/o/[slug]/settings">) {
  const { slug } = await props.params;
  const { saved, error } = await props.searchParams;
  const { supabase, user, isAdmin } = await requireConsole(slug, "research");
  const { t } = await getT();
  const consent = isAdmin ? null : await getConsent(supabase, user.id);
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t.settings}</h1>
      <div className="mt-4">
        <Flash saved={saved} error={error} t={t} />
      </div>
      {consent && <ConsentSettings consent={consent} slug={slug} back={`/research/o/${slug}/settings`} />}
    </div>
  );
}
