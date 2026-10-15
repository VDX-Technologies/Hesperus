import Image from "next/image";
import Link from "next/link";
import { setLocale, signOut } from "@/app/actions";
import type { Dict } from "@/lib/i18n";
import type { Locale } from "@/lib/modules/types";

export function Header({
  title,
  nav,
  t,
  locale,
  path,
  isAdmin,
}: {
  title: string;
  nav: { href: string; label: string; badge?: number }[];
  t: Dict;
  locale: Locale;
  path: string;
  isAdmin: boolean;
}) {
  return (
    <header className="sticky top-0 z-10 border-b border-line-soft bg-ink-950/85 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <Image src="/vdx-symbol.png" alt="VDX" width={26} height={26} />
          <span className="font-semibold tracking-tight">
            VDX <span className="font-normal text-mist">Core</span>
          </span>
        </Link>
        <span className="hidden text-sm text-mist sm:inline">{title}</span>
        <nav className="flex flex-1 items-center gap-1 text-sm">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className="rounded-md px-2.5 py-1.5 text-mist hover:bg-steel hover:text-frost">
              {n.label}
              {!!n.badge && <span className="num ml-1.5 rounded-full bg-alarm px-1.5 text-xs text-ink-950">{n.badge}</span>}
            </Link>
          ))}
          {isAdmin && (
            <Link href="/admin" className="rounded-md px-2.5 py-1.5 text-ice hover:bg-steel">
              {t.console}
            </Link>
          )}
        </nav>
        <form action={setLocale} className="flex text-xs">
          <input type="hidden" name="back" value={path} />
          {(["en", "it"] as const).map((l) => (
            <button key={l} name="locale" value={l} className={`px-1.5 py-1 uppercase ${l === locale ? "text-frost" : "text-dim hover:text-mist"}`}>
              {l}
            </button>
          ))}
        </form>
        <form action={signOut}>
          <button className="text-xs text-dim hover:text-frost">{t.signOut}</button>
        </form>
      </div>
    </header>
  );
}
