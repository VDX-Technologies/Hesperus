import Image from "next/image";
import Link from "next/link";
import { setLocale, signOut } from "@/app/actions";
import type { Dict } from "@/lib/i18n";
import type { Locale } from "@/lib/packages/types";
import { SidebarNav } from "@/components/sidebar-nav";

export function Header({ title, nav, t, locale, path, isAdmin }: {
  title: string;
  nav: { href: string; label: string; badge?: number }[];
  t: Dict;
  locale: Locale;
  path: string;
  isAdmin: boolean;
}) {
  const extra = isAdmin ? { href: "/admin", label: t.console } : undefined;
  return (
    <>
      <header className="safe-top sticky top-0 z-30 border-b border-line-soft bg-ink-950/95 backdrop-blur lg:hidden">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <Image src="/vdx-symbol.png" alt="VDX" width={24} height={24} />
            <span className="whitespace-nowrap text-sm font-semibold tracking-tight">VDX <span className="font-normal text-mist">Core</span></span>
          </Link>
          <span className="hidden truncate text-sm text-mist sm:inline">{title}</span>
          <div className="ml-auto flex items-center gap-2">
            <form action={setLocale} className="flex text-xs">
              <input type="hidden" name="back" value={path} />
              {(["en", "it"] as const).map((l) => (
                <button key={l} name="locale" value={l} aria-pressed={l === locale}
                  className={`min-h-9 px-1.5 uppercase ${l === locale ? "text-frost" : "text-dim hover:text-mist"}`}>{l}</button>
              ))}
            </form>
            <form action={signOut}><button className="min-h-9 px-1 text-xs text-dim hover:text-frost">{t.signOut}</button></form>
          </div>
        </div>
        <div className="mx-auto max-w-7xl px-4 pb-2 sm:px-6">
          <SidebarNav nav={nav} extra={extra} orientation="horizontal" label={t.primaryNav} />
        </div>
      </header>

      <aside className="safe-y fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-line-soft bg-ink-950/95 backdrop-blur lg:flex">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-5">
          <Link href="/" className="flex items-center gap-3 rounded-md px-2 py-1">
            <Image src="/vdx-symbol.png" alt="VDX" width={30} height={30} />
            <span className="text-base font-semibold tracking-tight">VDX <span className="font-normal text-mist">Core</span></span>
          </Link>
          <div className="my-7 rounded-lg border border-line-soft bg-ink-900 px-3 py-3">
            <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-dim">{t.workspace}</div>
            <div className="mt-1 truncate text-sm font-medium text-frost" title={title}>{title}</div>
          </div>
          <SidebarNav nav={nav} extra={extra} label={t.primaryNav} />
        </div>
        <div className="mt-auto border-t border-line-soft px-4 py-4">
          <form action={setLocale} className="mb-3 flex items-center justify-between px-2">
            <input type="hidden" name="back" value={path} />
            <span className="text-xs text-dim">{t.language}</span>
            <div className="flex rounded-md border border-line-soft bg-ink-900 p-0.5">
              {(["en", "it"] as const).map((l) => (
                <button key={l} name="locale" value={l} aria-pressed={l === locale}
                  className={`rounded px-2 py-1 text-[11px] uppercase ${l === locale ? "bg-steel text-frost" : "text-dim hover:text-mist"}`}>{l}</button>
              ))}
            </div>
          </form>
          <form action={signOut}>
            <button className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-mist hover:bg-ink-800 hover:text-frost">
              <span className="flex h-[18px] w-[18px] items-center justify-center text-dim" aria-hidden="true">↪</span>{t.signOut}
            </button>
          </form>
        </div>
      </aside>
    </>
  );
}
