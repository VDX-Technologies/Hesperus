import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Locale } from "@/lib/packages/types";

export const CONSENT_VERSION = "2026-10";

export type Consent = { granted: boolean; version: string; signed_name: string; signed_at: string; changed_at: string };

export async function getConsent(supabase: SupabaseClient, userId: string): Promise<Consent | null> {
  const { data } = await supabase
    .from("research_consents")
    .select("granted, version, signed_name, signed_at, changed_at")
    .eq("user_id", userId)
    .maybeSingle();
  return data;
}

export const CONSENT_DOC: Record<Locale, { title: string; intro: string; sections: { title: string; body: string }[] }> = {
  it: {
    title: "Consenso all'uso dei dati per ricerca scientifica e attività di laboratorio",
    intro:
      "Prima di iniziare ti chiediamo di leggere e firmare questo documento. Riguarda i dati raccolti dalla piattaforma VDX Core tramite i sensori, i registri e i file caricati nel tuo account.",
    sections: [
      {
        title: "1. Titolare",
        body: "VDX Technologies è titolare del trattamento dei dati raccolti tramite VDX Core, ai sensi del Regolamento (UE) 2016/679 (GDPR).",
      },
      {
        title: "2. Quali dati",
        body: "Misure dei sensori (temperatura, umidità, bagnatura fogliare e simili), dati di campo registrati (colture, trattamenti, registri), file caricati e i relativi metadati (data, luogo, dispositivo).",
      },
      {
        title: "3. Finalità",
        body: "Ricerca scientifica, sviluppo e validazione di modelli agronomici, prove e analisi di laboratorio, miglioramento dei dispositivi e degli algoritmi VDX. I risultati possono essere pubblicati solo in forma aggregata o anonimizzata.",
      },
      {
        title: "4. Come vengono trattati",
        body: "I dati sono pseudonimizzati prima dell'uso a fini di ricerca, conservati su infrastrutture nell'Unione Europea e accessibili solo al personale autorizzato e a enti di ricerca partner vincolati alla riservatezza. Non vengono venduti a terzi.",
      },
      {
        title: "5. Durata",
        body: "Il consenso vale fino alla revoca. I dati già anonimizzati e i risultati già pubblicati non possono essere ritirati.",
      },
      {
        title: "6. I tuoi diritti",
        body: "Puoi revocare il consenso in qualsiasi momento dalla pagina Impostazioni, senza conseguenze sull'uso del servizio. Hai inoltre diritto di accesso, rettifica, cancellazione, limitazione e opposizione, e di proporre reclamo al Garante per la protezione dei dati personali.",
      },
    ],
  },
  en: {
    title: "Consent to the use of data for scientific research and laboratory work",
    intro:
      "Before you start, please read and sign this document. It covers the data collected by the VDX Core platform through sensors, registers and files uploaded to your account.",
    sections: [
      {
        title: "1. Controller",
        body: "VDX Technologies is the controller of the data collected through VDX Core, under Regulation (EU) 2016/679 (GDPR).",
      },
      {
        title: "2. What data",
        body: "Sensor measurements (temperature, humidity, leaf wetness and similar), recorded field data (crops, treatments, registers), uploaded files and their metadata (date, place, device).",
      },
      {
        title: "3. Purposes",
        body: "Scientific research, development and validation of agronomic models, laboratory tests and analyses, improvement of VDX devices and algorithms. Results may be published only in aggregated or anonymised form.",
      },
      {
        title: "4. How it is handled",
        body: "Data is pseudonymised before research use, stored on infrastructure in the European Union and accessible only to authorised staff and partner research institutions bound by confidentiality. It is never sold to third parties.",
      },
      {
        title: "5. Duration",
        body: "Consent lasts until you withdraw it. Data already anonymised and results already published cannot be withdrawn.",
      },
      {
        title: "6. Your rights",
        body: "You can withdraw consent at any time from the Settings page, with no effect on your use of the service. You also have the right of access, rectification, erasure, restriction and objection, and to lodge a complaint with your data protection authority.",
      },
    ],
  },
};
