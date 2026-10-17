"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { safePath } from "@/lib/safe-path";

export async function setLocale(formData: FormData) {
  const v = formData.get("locale");
  if (v === "en" || v === "it") (await cookies()).set("locale", v, { path: "/", maxAge: 60 * 60 * 24 * 365 });
  redirect(safePath(formData.get("back")));
}

export async function signOut() {
  await (await createClient()).auth.signOut();
  redirect("/login");
}
