import { notFound, redirect } from "next/navigation";
import { Metadata } from "next";
import { requireOrg } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { getConsent } from "@/lib/consent";
import { Header } from "@/components/header";
import { hasConsole } from "@/lib/consoles";

export const metadata: Metadata = {
  title: { default: "VDX Research", template: "%s · VDX Research" },
  description: "Research projects, their runs and their results.",
};

/** The research console: the same organization and data as Terra, read through the research types. */
export default async function ResearchLayout(props: LayoutProps<"/research/o/[slug]">) {
  const { slug } = await props.params;
  const { supabase, user, org, isAdmin } = await requireOrg(slug);
  // VDX turns the console on per organization, from the vendor console
  if (!hasConsole(org, "research")) notFound();
  const { t, locale } = await getT();
  // the consent is signed once, on the main console
  if (!isAdmin && !(await getConsent(supabase, user.id))) redirect(`/terra/o/${slug}`);
  return (
    <div className="min-h-screen lg:pl-64">
      <Header
        title={`${org.name} · ${t.research}`}
        t={t}
        locale={locale}
        path={`/research/o/${slug}`}
        isAdmin={isAdmin}
        nav={[
          { href: `/research/o/${slug}`, label: t.projects },
          { href: `/terra/o/${slug}/registers/objects`, label: t.schemaEditor },
          { href: `/terra/o/${slug}/activity`, label: t.activity },
          { href: `/terra/o/${slug}`, label: "VDX Terra" },
        ]}
      />
      <main className="mx-auto max-w-7xl px-4 pb-16 pt-5 sm:px-6 lg:px-8 lg:pt-7">{props.children}</main>
    </div>
  );
}
