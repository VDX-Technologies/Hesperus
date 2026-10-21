import type { MetadataRoute } from "next";

/** PWA: installable on phones and desktops ("Add to Home Screen" / "Install app"). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "VDX Core",
    short_name: "VDX Core",
    description: "One platform for every VDX product.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#07080a",
    theme_color: "#050608",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
