"use client";
import { useEffect } from "react";

/** Marks this visit to the dashboard once it has been seen (see the visit route). */
export function VisitMarker({ slug }: { slug: string }) {
  useEffect(() => {
    void fetch(`/research/o/${slug}/visit`, { method: "POST" }).catch(() => {});
  }, [slug]);
  return null;
}
