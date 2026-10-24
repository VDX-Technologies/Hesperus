import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { consoleHome } from "@/lib/consoles";

/** Entry point: VDX staff go to the console, customers to their organization. */
export default async function Home() {
  const { supabase, user, isAdmin } = await requireUser();
  if (isAdmin) redirect("/admin");
  const { data } = await supabase.from("memberships").select("organizations(slug, consoles)").eq("user_id", user.id).limit(1);
  const org = data?.[0]?.organizations as unknown as { slug: string; consoles: string[] } | null;
  const home = org && consoleHome(org, org.slug);
  if (home) redirect(home);
  const { t } = await getT();
  return <p className="p-10 text-mist">{t.noOrg}</p>;
}
