"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function setLocale(formData: FormData) {
  const v = formData.get("locale");
  if (v === "en" || v === "it") (await cookies()).set("locale", v, { path: "/", maxAge: 60 * 60 * 24 * 365 });
  redirect(String(formData.get("back") || "/"));
}

export async function signOut() {
  await (await createClient()).auth.signOut();
  redirect("/login");
}
