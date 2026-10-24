import { CONSENT_DOC } from "@/lib/consent";
import type { Dict } from "@/lib/i18n";
import type { Locale } from "@/lib/packages/types";
import { signConsent } from "@/app/terra/o/[slug]/consent-actions";
import { SubmitButton } from "@/components/submit-button";

/** Research consent document shown over the console until the user signs it (first access only). */
export function ConsentGate({ slug, email, t, locale }: { slug: string; email?: string; t: Dict; locale: Locale }) {
  const doc = CONSENT_DOC[locale];
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="consent-title" className="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/85 backdrop-blur-sm sm:items-center sm:p-6">
      <form action={signConsent} className="card safe-y flex max-h-dvh w-full max-w-2xl flex-col sm:max-h-[90dvh]">
        <input type="hidden" name="slug" value={slug} />
        <div className="border-b border-line-soft px-5 py-4 sm:px-6">
          <p className="text-[11px] uppercase tracking-[0.14em] text-dim">{t.consentKicker}</p>
          <h2 id="consent-title" className="mt-1 text-lg font-semibold tracking-tight">{doc.title}</h2>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 text-sm leading-relaxed text-mist sm:px-6">
          <p>{doc.intro}</p>
          {doc.sections.map((s) => (
            <section key={s.title} className="mt-4">
              <h3 className="font-medium text-frost">{s.title}</h3>
              <p className="mt-1">{s.body}</p>
            </section>
          ))}
        </div>
        <div className="flex flex-col gap-3 border-t border-line-soft px-5 py-4 sm:px-6">
          <label className="flex items-start gap-2.5 text-sm text-frost">
            <input type="checkbox" name="accept" required className="mt-0.5 h-4 w-4 shrink-0" />
            {t.consentAccept}
          </label>
          <label className="flex flex-col gap-1.5 text-sm text-mist">
            {t.consentSignature}
            <input name="name" required minLength={2} maxLength={200} autoComplete="name" className="h-11" />
          </label>
          <p className="text-xs text-dim">
            {email} · {new Date().toLocaleDateString(locale)} · {t.consentWithdrawHint}
          </p>
          <SubmitButton pending={t.saving} className="h-11 rounded-lg bg-frost font-medium text-ink-950 transition-colors hover:bg-white">
            {t.consentSign}
          </SubmitButton>
        </div>
      </form>
    </div>
  );
}
