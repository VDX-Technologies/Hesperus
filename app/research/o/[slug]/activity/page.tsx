import { ActivityView } from "@/components/activity-view";
import { researchContext } from "../context";

export default async function Activity(props: { params: Promise<{ slug: string }>; searchParams: Promise<{ before?: string | string[] }> }) {
  const { slug } = await props.params;
  const { db } = await researchContext(slug);
  const { before } = await props.searchParams;
  return <ActivityView db={db} before={before} href={`/research/o/${slug}/activity`} />;
}
