"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

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
      .on("postgres_changes", { event: "*", schema: "public", table: "objects", filter: `tenant_id=eq.${orgId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "object_alerts", filter: `tenant_id=eq.${orgId}` }, refresh)
      .subscribe();
    const every = setInterval(() => router.refresh(), 60_000);
    return () => {
      clearTimeout(timer);
      clearInterval(every);
      supabase.removeChannel(ch);
    };
  }, [orgId, router]);
  return null;
}
