import { Metadata } from "next";
import { requireConsole } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { getConsent } from "@/lib/consent";
import { Header } from "@/components/header";
import { ConsentGate } from "@/components/consent-gate";
import { enabledConsoles } from "@/lib/consoles";

export const metadata: Metadata = {
  title: { default: "VDX Research", template: "%s · VDX Research" },
  description: "Research projects, their runs and their results.",
};

/** The research console: a web app of its own on the shared engine, read through the research types. */
export default async function ResearchLayout(props: LayoutProps<"/research/o/[slug]">) {
  const { slug } = await props.params;
  // VDX turns the console on per organization, from the vendor console
  const { supabase, user, org, isAdmin } = await requireConsole(slug, "research");
  const { t, locale } = await getT();
  // the consent is signed once, on whichever console the user opens first
  const mustSign = !isAdmin && !(await getConsent(supabase, user.id));
  return (
    <>
      <div className="min-h-screen lg:pl-64" inert={mustSign}>
        <Header
          title={`${org.name} · ${t.research}`}
          t={t}
          locale={locale}
          path={`/research/o/${slug}`}
          isAdmin={isAdmin}
          nav={[
            { href: `/research/o/${slug}`, label: t.projects },
            { href: `/research/o/${slug}/types`, label: t.schemaEditor },
            { href: `/research/o/${slug}/activity`, label: t.activity },
            { href: `/research/o/${slug}/settings`, label: t.settings },
            // the organization's other consoles, by their own entry point
            ...enabledConsoles(org)
              .filter((c) => c.id !== "research")
              .map((c) => ({ href: c.href(slug), label: c.name })),
          ]}
        />
        <main className="mx-auto max-w-7xl px-4 pb-16 pt-5 sm:px-6 lg:px-8 lg:pt-7">{props.children}</main>
      </div>
      {mustSign && <ConsentGate slug={slug} home={`/research/o/${slug}`} email={user.email} t={t} locale={locale} />}
    </>
  );
}
