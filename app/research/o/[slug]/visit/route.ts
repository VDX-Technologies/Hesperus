/**
 * POST /research/o/<slug>/visit - marks a visit to the dashboard, for its "new since your last
 * visit". A route rather than a Server Action: an action setting a cookie re-renders the page,
 * which would count from the visit just marked.
 */
import { cookies } from "next/headers";
import { lastVisit, VISIT_COOKIE } from "@/lib/research";

export async function POST(_req: Request, ctx: RouteContext<"/research/o/[slug]/visit">) {
  const { slug } = await ctx.params;
  const jar = await cookies();
  const { next } = lastVisit(jar.get(VISIT_COOKIE)?.value, Date.now());
  if (next) jar.set(VISIT_COOKIE, next, { path: `/research/o/${slug}`, maxAge: 60 * 60 * 24 * 365, httpOnly: true, sameSite: "lax" });
  return new Response(null, { status: 204 });
}
