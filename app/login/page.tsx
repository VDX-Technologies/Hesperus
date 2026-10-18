import Image from "next/image";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getT } from "@/lib/i18n";
import { setLocale } from "@/app/actions";
import { SubmitButton } from "@/components/submit-button";
import { HeroFaces } from "@/components/core-faces/HeroFaces";

async function signIn(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: String(formData.get("email")),
    password: String(formData.get("password")),
  });
  redirect(error ? "/login?error=1" : "/");
}

export default async function Login(props: PageProps<"/login">) {
  const { error } = await props.searchParams;
  const { t, locale } = await getT();
  return (
    <main className="safe-y relative flex min-h-dvh flex-col lg:flex-row">
      {/* Brand panel: full height on desktop, compact header on phones */}
      <section className="relative overflow-hidden border-b border-line-soft bg-ink-950 px-6 pb-8 pt-8 lg:flex lg:w-1/2 lg:flex-col lg:justify-between lg:border-b-0 lg:border-r lg:p-12">
        {/* Live VDX Core faces, dimmed under ink gradients so the logo stays readable */}
        <div className="pointer-events-none absolute inset-0 hidden brightness-[.6] saturate-[.85] lg:block" aria-hidden>
          <HeroFaces framed />
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_20%_10%,var(--color-ink-950)_0%,transparent_55%)]" />
          <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/40 to-ink-950/70" />
        </div>
        <div className="relative flex items-center gap-3">
          <Image src="/vdx-symbol.png" alt="" width={36} height={36} priority />
          <div>
            <div className="text-lg font-semibold tracking-tight">
              VDX <span className="font-normal text-mist">Core</span>
            </div>
            <div className="text-xs text-dim">VDX Technologies</div>
          </div>
        </div>
        <p className="relative mt-8 hidden text-xs text-dim lg:block">© {new Date().getFullYear()} VDX Technologies</p>
      </section>

      {/* Form */}
      <section className="flex flex-1 flex-col px-6 py-8 lg:px-12">
        <form action={setLocale} className="flex justify-end text-xs">
          <input type="hidden" name="back" value="/login" />
          {(["en", "it"] as const).map((l) => (
            <button key={l} name="locale" value={l} className={`min-h-9 px-2.5 uppercase ${l === locale ? "text-frost" : "text-dim hover:text-mist"}`}>
              {l}
            </button>
          ))}
        </form>
        <div className="flex flex-1 items-center justify-center py-8">
          <form action={signIn} className="flex w-full max-w-sm flex-col gap-5">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{t.loginWelcome}</h1>
              <p className="mt-1.5 text-sm text-mist">{t.loginSubtitle}</p>
            </div>
            {error && (
              <div role="alert" className="flex items-center gap-2.5 rounded-lg border border-alarm/40 bg-alarm/10 px-3 py-2.5 text-sm text-alarm">
                <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <circle cx="8" cy="8" r="6.5" />
                  <path d="M8 4.8v3.6M8 11h.01" strokeLinecap="round" />
                </svg>
                {t.wrongLogin}
              </div>
            )}
            <label className="flex flex-col gap-1.5 text-sm text-mist">
              {t.email}
              <input name="email" type="email" required autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} className="h-11" />
            </label>
            <label className="flex flex-col gap-1.5 text-sm text-mist">
              {t.password}
              <input name="password" type="password" required autoComplete="current-password" className="h-11" />
            </label>
            <SubmitButton pending={t.signingIn} className="mt-1 h-11 rounded-lg bg-frost font-medium text-ink-950 transition-colors hover:bg-white">
              {t.signIn}
            </SubmitButton>
            <p className="text-center text-xs text-dim">{t.loginHelp}</p>
          </form>
        </div>
        <p className="text-center text-xs text-dim lg:hidden">© {new Date().getFullYear()} VDX Technologies</p>
      </section>
    </main>
  );
}
