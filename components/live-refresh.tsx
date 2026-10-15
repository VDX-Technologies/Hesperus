"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/** Re-renders the page when this organization's devices or alerts change (Supabase Realtime). */
export function LiveRefresh({ orgId }: { orgId: string }) {
  const router = useRouter();
  useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 800);
    };
    const ch = supabase
      .channel(`org-${orgId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "devices", filter: `org_id=eq.${orgId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "alerts", filter: `org_id=eq.${orgId}` }, refresh)
      .subscribe();
    const every = setInterval(() => router.refresh(), 60_000); // also turns stale devices "offline"
    return () => {
      clearTimeout(timer);
      clearInterval(every);
      supabase.removeChannel(ch);
    };
  }, [orgId, router]);
  return null;
}
