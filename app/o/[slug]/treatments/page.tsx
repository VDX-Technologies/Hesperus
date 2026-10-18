import { redirect } from "next/navigation";

/** The treatments register is now the generic one; old links (and `?crop=`) still land there. */
export default async function Treatments(props: PageProps<"/o/[slug]/treatments">) {
  const { slug } = await props.params;
  const sp = await props.searchParams;
  const crop = typeof sp.crop === "string" ? `?obj=${encodeURIComponent(sp.crop)}` : "";
  redirect(`/o/${slug}/registers/agronomy.treatment${crop}`);
}
