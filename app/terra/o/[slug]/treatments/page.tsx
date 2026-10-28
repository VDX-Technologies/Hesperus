import { redirect } from "next/navigation";

export default async function Treatments(props: PageProps<"/terra/o/[slug]/treatments">) {
  const { slug } = await props.params;
  const sp = await props.searchParams;
  const crop = typeof sp.crop === "string" ? `?obj=${encodeURIComponent(sp.crop)}` : "";
  redirect(`/terra/o/${slug}/registers/agronomy.treatment${crop}`);
}
