import type { Locale } from "./packages/types";

export type ConsoleDef = { id: string; name: string; tagline: Record<Locale, string>; href: (slug: string) => string };

export const CONSOLES: ConsoleDef[] = [
  {
    id: "terra",
    name: "VDX Terra",
    tagline: { en: "Sites, devices, alerts and registers", it: "Siti, dispositivi, allarmi e registri" },
    href: (slug) => `/terra/o/${slug}`,
  },
  {
    id: "research",
    name: "VDX Research",
    tagline: { en: "Research projects, their runs and their results", it: "Progetti di ricerca, esecuzioni e risultati" },
    href: (slug) => `/research/o/${slug}`,
  },
];

export const parseConsoles = (ids: unknown[]): string[] => CONSOLES.map((c) => c.id).filter((id) => ids.includes(id));

export const hasConsole = (org: { consoles?: string[] | null }, id: string) => (org.consoles ?? []).includes(id);

export const enabledConsoles = (org: { consoles?: string[] | null }) => CONSOLES.filter((c) => hasConsole(org, c.id));

export const consoleHome = (org: { consoles?: string[] | null }, slug: string): string | null =>
  enabledConsoles(org)[0]?.href(slug) ?? null;
