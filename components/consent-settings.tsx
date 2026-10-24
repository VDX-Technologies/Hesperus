import { getT } from "@/lib/i18n";
import { setConsent } from "@/lib/consent-actions";
import type { Consent } from "@/lib/consent";
import { SectionTitle } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";

/** The person's data-processing consent, with the button to withdraw or grant it again; `back` is the page showing it. */
export async function ConsentSettings({ consent, slug, back }: {
  consent: Consent;
  slug: string;
  back: string;
}) {
  const { t, locale } = await getT();
  return (
    <section>
      <SectionTitle>{t.consentSettings}</SectionTitle>
      <form action={setConsent} className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="back" value={back} />
        <input type="hidden" name="granted" value={consent.granted ? "0" : "1"} />
        <div className="min-w-0">
          <div className="text-sm font-medium text-ice">{consent.granted ? t.consentGranted : t.consentWithdrawn}</div>
          <p className="mt-0.5 text-xs text-mist">
            {t.consentSignedBy} {consent.signed_name} · {new Date(consent.signed_at).toLocaleDateString(locale)} · v{consent.version}
            {!consent.granted && <> · {t.consentWithdrawnOn} {new Date(consent.changed_at).toLocaleDateString(locale)}</>}
          </p>
        </div>
        {consent.granted ? (
          <ConfirmButton message={t.consentWithdrawConfirm} className="btn shrink-0 text-xs">
            {t.consentWithdraw}
          </ConfirmButton>
        ) : (
          <button className="btn shrink-0 border-frost text-xs">{t.consentRegrant}</button>
        )}
      </form>
    </section>
  );
}
