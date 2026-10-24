import { requireOrg } from "@/lib/auth";
import { tenantDb } from "@/lib/engine/db";
import { ActivityView } from "@/components/activity-view";

export default async function Activity(props: PageProps<"/terra/o/[slug]/activity">) {
  const { slug } = await props.params;
  const { before } = await props.searchParams;
  const { org } = await requireOrg(slug);
  return <ActivityView db={tenantDb(org.id)} before={before} href={`/terra/o/${slug}/activity`} />;
}
