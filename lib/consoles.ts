// The consoles VDX turns on per organization (organizations.consoles). Each is a web app of its
// own under its prefix (/terra, /research), on the same engine, database and storage: none links
// into another's pages, so an organization can have any of them without the others.
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

/** Only the known consoles, once each. */
export const parseConsoles = (ids: unknown[]): string[] => CONSOLES.map((c) => c.id).filter((id) => ids.includes(id));

export const hasConsole = (org: { consoles?: string[] | null }, id: string) => (org.consoles ?? []).includes(id);

export const enabledConsoles = (org: { consoles?: string[] | null }) => CONSOLES.filter((c) => hasConsole(org, c.id));

/** Where the organization's users land: its first console, or null when it has none. */
export const consoleHome = (org: { consoles?: string[] | null }, slug: string): string | null =>
  enabledConsoles(org)[0]?.href(slug) ?? null;
