"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = { href: string; label: string; badge?: number };

function Icon({ name }: { name: string }) {
  const common = { className: "h-full w-full", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "alerts": return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><path d="M12 3 2.8 19h18.4L12 3Z" /><path d="M12 9v4m0 3h.01" /></svg>;
    case "registers": return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><path d="M4 5h16M4 12h16M4 19h16" /><circle cx="7" cy="5" r=".5" fill="currentColor" /><circle cx="7" cy="12" r=".5" fill="currentColor" /><circle cx="7" cy="19" r=".5" fill="currentColor" /></svg>;
    case "crops": return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><path d="M19.5 4.5c-7.7-.4-12.8 1.5-13.7 6.2-.6 3.2 1.8 5.5 4.8 4.9 4.8-.9 7-6.3 8.9-11.1Z" /><path d="M4 21c2.4-5.1 6.4-8.8 12-11.5" /></svg>;
    case "upload": return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5M4 14v6h16v-6" /></svg>;
    case "activity": return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><path d="M3 12h4l2.2-6 4.1 12 2.3-6H21" /></svg>;
    case "settings": return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" /><path d="m19.4 15 .1.1 1.1.9-1.6 2.8-1.4-.6a8 8 0 0 1-1.6.9l-.3 1.5h-3.2l-.3-1.5a8 8 0 0 1-1.6-.9l-1.4.6-1.6-2.8 1.1-.9a7 7 0 0 1 0-1.9l-1.1-.9 1.6-2.8 1.4.6a8 8 0 0 1 1.6-.9l.3-1.5h3.2l.3 1.5a8 8 0 0 1 1.6.9l1.4-.6 1.6 2.8-1.1.9a7 7 0 0 1-.1 1.8Z" /></svg>;
    case "customers": return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><circle cx="9" cy="8" r="3" /><path d="M3 20v-1.5A4.5 4.5 0 0 1 7.5 14h3a4.5 4.5 0 0 1 4.5 4.5V20M16 5.5a3 3 0 0 1 0 5.8M17 14h.5a3.5 3.5 0 0 1 3.5 3.5V20" /></svg>;
    case "engine": return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><path d="m13 2-8 12h6l-1 8 9-13h-6l1-7Z" /></svg>;
    case "overview": return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><rect x="3.5" y="3.5" width="7" height="7" rx="1.2" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.2" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.2" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.2" /></svg>;
    default: return <svg viewBox="0 0 24 24" aria-hidden="true" {...common}><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 12h8M12 8v8" /></svg>;
  }
}

function iconFor(item: Item) {
  if (/^\/[a-z]+\/o\/[^/]+$/.test(item.href)) return "overview";
  const key = item.href.split("/").at(-1) ?? "";
  if (key === "admin") return "customers";
  return key;
}

export function SidebarNav({ nav, extra, orientation = "vertical", label }: {
  nav: Item[];
  extra?: Item;
  orientation?: "vertical" | "horizontal";
  label: string;
}) {
  const pathname = usePathname();
  const horizontal = orientation === "horizontal";
  const renderItem = (item: Item, isExtra = false) => {
    const exactOnly = /^\/[a-z]+\/o\/[^/]+$/.test(item.href) || item.href === "/admin";
    const active = pathname === item.href || (!exactOnly && pathname.startsWith(`${item.href}/`));
    return (
      <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}
        className={`group flex shrink-0 items-center gap-3 rounded-lg text-sm transition-colors ${horizontal ? "px-3 py-2" : "w-full px-3 py-2.5"} ${active ? "bg-steel text-frost ring-1 ring-inset ring-ice/15" : "text-mist hover:bg-ink-800 hover:text-frost"} ${isExtra && !horizontal ? "mt-3 border-t border-line-soft pt-4" : ""}`}>
        <span className={`h-[18px] w-[18px] shrink-0 ${active ? "text-ice" : "text-dim group-hover:text-mist"}`}><Icon name={iconFor(item)} /></span>
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {!!item.badge && <span className={`num rounded-full px-1.5 py-0.5 text-[10px] ${active ? "bg-alarm text-ink-950" : "bg-alarm/15 text-alarm"}`}>{item.badge}</span>}
      </Link>
    );
  };
  return (
    <nav aria-label={label} className={horizontal ? "-mx-1 flex gap-1 overflow-x-auto [scrollbar-width:none]" : "flex flex-col gap-1"}>
      {nav.map((item) => renderItem(item))}
      {extra && renderItem(extra, true)}
    </nav>
  );
}
