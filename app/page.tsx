import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";

/** Entry point: VDX staff go to the console, customers to their organization. */
export default async function Home() {
  const { supabase, user, isAdmin } = await requireUser();
  if (isAdmin) redirect("/admin");
  const { data } = await supabase.from("memberships").select("organizations(slug)").eq("user_id", user.id).limit(1);
  const slug = (data?.[0]?.organizations as unknown as { slug: string } | null)?.slug;
  if (slug) redirect(`/o/${slug}`);
  const { t } = await getT();
  return <p className="p-10 text-mist">{t.noOrg}</p>;
}
