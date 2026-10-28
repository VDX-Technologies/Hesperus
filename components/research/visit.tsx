"use client";
import { useEffect } from "react";

export function VisitMarker({ slug }: { slug: string }) {
  useEffect(() => {
    void fetch(`/research/o/${slug}/visit`, { method: "POST" }).catch(() => {});
  }, [slug]);
  return null;
}
