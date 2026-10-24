// The consoles VDX turns on per organization besides Terra (organizations.consoles).
import type { Locale } from "./packages/types";

export type ConsoleDef = { id: string; name: string; tagline: Record<Locale, string>; href: (slug: string) => string };

export const CONSOLES: ConsoleDef[] = [
  {
    id: "research",
    name: "VDX Research",
    tagline: { en: "Research projects, their runs and their results", it: "Progetti di ricerca, esecuzioni e risultati" },
    href: (slug) => `/research/o/${slug}`,
  },
];

export const TERRA_HREF = (slug: string) => `/terra/o/${slug}`;

/** Only the known consoles, once each. */
export const parseConsoles = (ids: unknown[]): string[] => CONSOLES.map((c) => c.id).filter((id) => ids.includes(id));

export const hasConsole = (org: { consoles?: string[] | null }, id: string) => (org.consoles ?? []).includes(id);
