const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const DEFAULT_ATTRIBUTION = "© OpenStreetMap contributors";
const DEFAULT_ATTRIBUTION_URL = "https://www.openstreetmap.org/copyright";

export type WeatherTileSettings = {
  urlTemplate: string;
  origin: string;
  attribution: string;
  attributionUrl: string;
};

/** Accept a single HTTPS tile origin so the map and CSP use the same trusted provider. */
export function weatherTileSettings(): WeatherTileSettings {
  const configured = process.env.NEXT_PUBLIC_WEATHER_TILE_URL?.trim() || DEFAULT_TILE_URL;
  let urlTemplate = DEFAULT_TILE_URL;
  let origin = new URL(DEFAULT_TILE_URL.replaceAll("{z}", "0").replaceAll("{x}", "0").replaceAll("{y}", "0")).origin;
  let customProvider = false;
  try {
    if (!/[{}]/.test(configured.replaceAll("{z}", "").replaceAll("{x}", "").replaceAll("{y}", ""))) {
      const parsed = new URL(configured.replaceAll("{z}", "0").replaceAll("{x}", "0").replaceAll("{y}", "0"));
      if (parsed.protocol === "https:" && !parsed.username && !parsed.password && ["{z}", "{x}", "{y}"].every((part) => configured.includes(part))) {
        urlTemplate = configured;
        origin = parsed.origin;
        customProvider = configured !== DEFAULT_TILE_URL;
      }
    }
  } catch {
    // Fall back to the default provider for invalid or non-HTTPS configuration.
  }

  const attributionUrlRaw = customProvider ? process.env.NEXT_PUBLIC_WEATHER_TILE_ATTRIBUTION_URL?.trim() : null;
  let attributionUrl = DEFAULT_ATTRIBUTION_URL;
  if (attributionUrlRaw) {
    try {
      const parsed = new URL(attributionUrlRaw);
      if (parsed.protocol === "https:" && !parsed.username && !parsed.password) attributionUrl = parsed.toString();
    } catch {
      // Keep the default attribution destination when the configured URL is invalid.
    }
  }

  return {
    urlTemplate,
    origin,
    attribution: (customProvider ? process.env.NEXT_PUBLIC_WEATHER_TILE_ATTRIBUTION?.trim() : null) || DEFAULT_ATTRIBUTION,
    attributionUrl,
  };
}
