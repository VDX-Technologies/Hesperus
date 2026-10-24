import { ActivityView } from "@/components/activity-view";
import { researchContext } from "../context";

export default async function Activity(props: PageProps<"/research/o/[slug]/activity">) {
  const { slug } = await props.params;
  const { before } = await props.searchParams;
  const { db } = await researchContext(slug);
  return <ActivityView db={db} before={before} href={`/research/o/${slug}/activity`} />;
}
